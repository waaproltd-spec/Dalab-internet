import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { rateLimit } from "../auth/rateLimit.js";
import { sendJson } from "../utils/camelCase.js";
import { parseDataUri } from "../utils/dataUri.js";
import { notifyCustomer } from "../services/customerNotify.js";
import { sendPushToAllAgents } from "../services/push.js";
import { recordActivity } from "../utils/activityLog.js";
import { formatUssdAmount } from "../utils/ussdFormatting.js";
import { validateMobileNumber } from "../lib/phoneValidation.js";

// Shop: DALAB's 4th independent customer-facing service (Internet | eBadal
// | Reseller | Shop) — see migration 074's header comment for the full
// design rationale (payment collection numbers, why confirmation is manual
// rather than wired into smsLogs.routes.ts's SMS-matching pipeline).
//
// Every /admin/shop/* route below — including plain GETs — requires the
// "shop.manage" permission, not just requireStaff(): the whole section is
// hidden from a regular Admin's sidebar unless granted, and per this
// session's own Admin Permissions policy that must hold at the API layer
// too, not just in the UI.
export const shopRouter = Router();

// Each product must carry 2-4 images (no video) -- enforced on the way in
// (POST won't add a 5th) and on the way out (DELETE won't drop below 2).
const MAX_PRODUCT_IMAGES = 4;
const MIN_PRODUCT_IMAGES = 2;

function generateShopOrderId(): string {
  return "SHP" + Math.floor(100000000 + Math.random() * 900000000);
}

// ==================== Public catalog (no auth — browsing before login) ====================

// image_data itself is never selected here (same reasoning as
// shop_product_images) -- has_image just tells a client whether to render
// GET /shop/categories/:id/image or fall back to the emoji.
const CATEGORY_COLUMNS = "id, name, emoji, position, active, (image_data IS NOT NULL) AS has_image";
const SUBCATEGORY_COLUMNS = "id, category_id, name, position, active";
// avg_rating/review_count are correlated subqueries rather than a JOIN +
// GROUP BY -- this constant gets spliced into several differently-shaped
// queries (dynamic WHERE clauses, LIMIT, etc.) below, and a subquery per
// column composes into any of them without also having to thread a GROUP
// BY/HAVING clause through every call site.
// price/old_price go through shop_effective_price()/shop_effective_old_price()
// (migration 083) so an active Flash Sale is reflected everywhere a product
// is read -- catalog list, detail, favorites, recently-viewed, recommended --
// without every one of those call sites separately joining
// shop_flash_sale_items. Order creation and cart validation below re-resolve
// the same functions independently at the moment of purchase, so what a
// customer is actually charged always matches what they were shown.
// images is a correlated subquery (not a join) for the same reason
// avg_rating/review_count above are -- and, critically, it's what actually
// lets every *list* route (public catalog, favorites, recently-viewed,
// recommended, the admin product grid) show a thumbnail at all: those
// routes never separately re-fetch shop_product_images the way the two
// single-product GET routes do (`{ ...product, images: await query(...) }`),
// so before this column existed here every one of them silently returned
// no images regardless of how many a product actually had -- the Customer
// App's card/grid always fell back to its placeholder icon, images only
// ever showed once a customer tapped into a product's own detail page.
// COALESCE(..., '[]') so a product with zero images gets an empty array,
// never null, matching what ShopProduct.fromJson already expects.
const PRODUCT_COLUMNS =
  "id, category_id, subcategory_id, name, description, " +
  "shop_effective_price(shop_products.id, price) AS price, " +
  "shop_effective_old_price(shop_products.id, price, old_price) AS old_price, " +
  "stock, brand, featured, is_new_arrival, best_seller, sold_count, active, created_at, " +
  "(SELECT ROUND(AVG(rating), 1) FROM shop_reviews WHERE product_id = shop_products.id) AS avg_rating, " +
  "(SELECT COUNT(*) FROM shop_reviews WHERE product_id = shop_products.id) AS review_count, " +
  "COALESCE((SELECT json_agg(json_build_object('id', spi.id, 'position', spi.position) ORDER BY spi.position) " +
  "FROM shop_product_images spi WHERE spi.product_id = shop_products.id), '[]') AS images";

const VARIANT_COLUMNS = "id, product_id, label, attributes, price, stock, sku, position";

// sort key -> ORDER BY clause. Looked up through this map (never
// interpolated directly from the query string) so an unrecognized/absent
// `sort` value can only ever fall back to "newest", never reach raw SQL.
const PRODUCT_SORTS: Record<string, string> = {
  newest: "created_at DESC",
  price_asc: "price ASC",
  price_desc: "price DESC",
  popularity: "sold_count DESC",
};

shopRouter.get("/shop/categories", async (_req, res) => {
  sendJson(res, 200, await query(`SELECT ${CATEGORY_COLUMNS} FROM shop_categories WHERE active=true ORDER BY position`));
});

// Not gated by active -- same reasoning as the product image route: an
// admin previewing a hidden category's image (or a client with a stale
// cached list) should never get a broken image, only a 404 if there's
// truly no image set.
shopRouter.get("/shop/categories/:id/image", async (req, res) => {
  const row = await queryOne<{ image_data: Buffer; mime_type: string }>(
    `SELECT image_data, image_mime_type AS mime_type FROM shop_categories WHERE id=$1`,
    [req.params.id]
  );
  if (!row?.image_data) return sendJson(res, 404, { error: "No image set for this category" });
  res.setHeader("Content-Type", row.mime_type);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(row.image_data);
});

// Generic subcategory support (migration 077) -- Electronics is the one
// category the spec calls for unlimited admin-defined subcategories, but
// nothing here is hardcoded to any one category's id.
shopRouter.get("/shop/subcategories", async (req, res) => {
  const { categoryId } = req.query;
  const rows = categoryId
    ? await query(`SELECT ${SUBCATEGORY_COLUMNS} FROM shop_subcategories WHERE active=true AND category_id=$1 ORDER BY position`, [categoryId])
    : await query(`SELECT ${SUBCATEGORY_COLUMNS} FROM shop_subcategories WHERE active=true ORDER BY position`);
  sendJson(res, 200, rows);
});

shopRouter.get("/shop/products", async (req, res) => {
  const { categoryId, subcategoryId, brand, minPrice, maxPrice, search, sort, featured, newArrivals, bestSellers, discounted } =
    req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `SELECT ${PRODUCT_COLUMNS} FROM shop_products WHERE active=true`;
  if (categoryId) { args.push(categoryId); sql += ` AND category_id=$${args.length}`; }
  if (subcategoryId) { args.push(subcategoryId); sql += ` AND subcategory_id=$${args.length}`; }
  if (brand) { args.push(brand); sql += ` AND brand=$${args.length}`; }
  if (minPrice !== undefined && Number.isFinite(Number(minPrice))) { args.push(Number(minPrice)); sql += ` AND price >= $${args.length}`; }
  if (maxPrice !== undefined && Number.isFinite(Number(maxPrice))) { args.push(Number(maxPrice)); sql += ` AND price <= $${args.length}`; }
  if (search) { args.push(`%${search}%`); sql += ` AND name ILIKE $${args.length}`; }
  if (featured === "true") sql += ` AND featured=true`;
  if (newArrivals === "true") sql += ` AND is_new_arrival=true`;
  if (bestSellers === "true") sql += ` AND best_seller=true`;
  if (discounted === "true") {
    sql += ` AND (old_price IS NOT NULL AND old_price > price OR EXISTS (
      SELECT 1 FROM shop_flash_sale_items fsi JOIN shop_flash_sales fs ON fs.id = fsi.flash_sale_id
      WHERE fsi.product_id = shop_products.id AND fs.active = true AND now() BETWEEN fs.starts_at AND fs.ends_at
    ))`;
  }
  sql += ` ORDER BY ${PRODUCT_SORTS[sort ?? ""] ?? PRODUCT_SORTS.newest} LIMIT 200`;
  sendJson(res, 200, await query(sql, args));
});

// Registered before the generic /shop/products/:id below -- Express
// matches route patterns in registration order, and :id would otherwise
// swallow this literal path, treating "recently-viewed" as a product id.
shopRouter.get("/shop/products/recently-viewed", requireAuth("customer"), async (req, res) => {
  const rows = await query(
    `SELECT ${PRODUCT_COLUMNS} FROM shop_products
     WHERE active=true AND id IN (SELECT product_id FROM shop_product_views WHERE customer_id=$1)
     ORDER BY (SELECT viewed_at FROM shop_product_views WHERE customer_id=$1 AND product_id=shop_products.id) DESC
     LIMIT 20`,
    [req.auth!.sub]
  );
  sendJson(res, 200, rows);
});

shopRouter.get("/shop/products/:id", async (req, res) => {
  const product = await queryOne(`SELECT ${PRODUCT_COLUMNS} FROM shop_products WHERE id=$1 AND active=true`, [req.params.id]);
  if (!product) return sendJson(res, 404, { error: "Product not found" });
  const images = await query(`SELECT id, position FROM shop_product_images WHERE product_id=$1 ORDER BY position`, [req.params.id]);
  const variants = await query(`SELECT ${VARIANT_COLUMNS} FROM shop_product_variants WHERE product_id=$1 AND active=true ORDER BY position`, [req.params.id]);
  sendJson(res, 200, { ...product, images, variants });
});

// Public -- a signed-out browser can see a product's variants same as its
// images; only placing an order requires auth. Kept as its own route (in
// addition to being embedded in GET /shop/products/:id above) for a screen
// that already has the product loaded and just needs a fresh stock read.
shopRouter.get("/shop/products/:id/variants", async (req, res) => {
  sendJson(res, 200, await query(`SELECT ${VARIANT_COLUMNS} FROM shop_product_variants WHERE product_id=$1 AND active=true ORDER BY position`, [req.params.id]));
});

// Back-in-stock notifications: a customer taps "Notify Me" on an
// out-of-stock product. Idempotent against a double-tap via the partial
// unique index from migration 085 (ON CONFLICT DO NOTHING); admin restocking
// the product fires the actual notification (see PUT /admin/shop/products/:id).
shopRouter.post("/shop/products/:id/notify-me", requireAuth("customer"), async (req, res) => {
  const product = await queryOne<{ stock: number }>(`SELECT stock FROM shop_products WHERE id=$1`, [req.params.id]);
  if (!product) return sendJson(res, 404, { error: "Product not found" });
  if (product.stock > 0) return sendJson(res, 409, { error: "This product is already in stock" });
  await query(
    `INSERT INTO shop_stock_notify_requests (customer_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [req.auth!.sub, req.params.id]
  );
  sendJson(res, 201, { subscribed: true });
});

// ==================== Bundle Deals ====================

const BUNDLE_COLUMNS = "id, name, description, bundle_price, active, created_at";

async function loadBundleItems(bundleId: string) {
  return query(
    `SELECT bi.product_id, bi.quantity, p.name, p.price, p.stock
     FROM shop_bundle_deal_items bi JOIN shop_products p ON p.id = bi.product_id
     WHERE bi.bundle_id=$1`,
    [bundleId]
  );
}

shopRouter.get("/shop/bundles", async (_req, res) => {
  const bundles = await query(`SELECT ${BUNDLE_COLUMNS} FROM shop_bundle_deals WHERE active=true ORDER BY created_at DESC`);
  const withItems = await Promise.all((bundles as any[]).map(async (b) => ({ ...b, items: await loadBundleItems(b.id) })));
  sendJson(res, 200, withItems);
});

shopRouter.get("/shop/bundles/:id", async (req, res) => {
  const bundle = await queryOne(`SELECT ${BUNDLE_COLUMNS} FROM shop_bundle_deals WHERE id=$1 AND active=true`, [req.params.id]);
  if (!bundle) return sendJson(res, 404, { error: "Bundle not found" });
  sendJson(res, 200, { ...bundle, items: await loadBundleItems(req.params.id) });
});

// ==================== Delivery Zones ====================

shopRouter.get("/shop/delivery-zones", async (_req, res) => {
  sendJson(res, 200, await query(`SELECT id, name, fee, position FROM shop_delivery_zones WHERE active=true ORDER BY position`));
});

// Not gated by active/stock — same reasoning as promo-images' image route:
// served by unguessable UUID, and an <img src> tag can't send an
// Authorization header anyway.
shopRouter.get("/shop/products/:productId/images/:imageId", async (req, res) => {
  const row = await queryOne<{ image_data: Buffer; mime_type: string }>(
    `SELECT image_data, mime_type FROM shop_product_images WHERE id=$1 AND product_id=$2`,
    [req.params.imageId, req.params.productId]
  );
  if (!row) return sendJson(res, 404, { error: "Image not found" });
  res.setHeader("Content-Type", row.mime_type);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(row.image_data);
});

// Upserted (viewed_at bumped), not appended -- only "did they view this,
// and when most recently" matters for Recently Viewed / Recommended.
// Fire-and-forget from the Customer App on opening Product Detail.
shopRouter.post("/shop/products/:id/view", requireAuth("customer"), async (req, res) => {
  if (!(await queryOne(`SELECT id FROM shop_products WHERE id=$1`, [req.params.id]))) {
    return sendJson(res, 404, { error: "Product not found" });
  }
  await query(
    `INSERT INTO shop_product_views (customer_id, product_id, viewed_at) VALUES ($1,$2,now())
     ON CONFLICT (customer_id, product_id) DO UPDATE SET viewed_at = now()`,
    [req.auth!.sub, req.params.id]
  );
  sendJson(res, 200, { recorded: true });
});

// Same-category products, excluding the product itself -- the standard
// "you might also like" shelf on a product's own detail page. Public
// (matches every other catalog read): a signed-out browser can still see
// related items.
shopRouter.get("/shop/products/:id/recommended", async (req, res) => {
  const product = await queryOne<{ category_id: string }>(`SELECT category_id FROM shop_products WHERE id=$1`, [req.params.id]);
  if (!product) return sendJson(res, 404, { error: "Product not found" });
  const rows = await query(
    `SELECT ${PRODUCT_COLUMNS} FROM shop_products
     WHERE active=true AND category_id=$1 AND id != $2
     ORDER BY best_seller DESC, sold_count DESC, created_at DESC LIMIT 8`,
    [product.category_id, req.params.id]
  );
  sendJson(res, 200, rows);
});

// Personalized per spec ("based on products viewed or purchased"): pools
// the categories of everything this customer has recently viewed or ever
// bought, then surfaces other active products from those categories they
// don't already own. Falls back to a plain featured/best-seller shelf for
// a customer with no view/purchase history yet, rather than an empty
// screen.
shopRouter.get("/shop/recommendations", requireAuth("customer"), async (req, res) => {
  const rows = await query(
    `WITH interest_categories AS (
       SELECT DISTINCT p.category_id FROM shop_products p WHERE p.id IN (
         SELECT product_id FROM shop_product_views WHERE customer_id=$1
         UNION
         SELECT oi.product_id FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
         WHERE o.customer_id=$1 AND oi.product_id IS NOT NULL
       )
     ),
     owned_or_viewed AS (
       SELECT product_id FROM shop_product_views WHERE customer_id=$1
       UNION
       SELECT oi.product_id FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
       WHERE o.customer_id=$1 AND oi.product_id IS NOT NULL
     )
     SELECT ${PRODUCT_COLUMNS} FROM shop_products
     WHERE active=true
       AND id NOT IN (SELECT product_id FROM owned_or_viewed)
       AND (
         category_id IN (SELECT category_id FROM interest_categories)
         OR NOT EXISTS (SELECT 1 FROM interest_categories)
       )
     ORDER BY
       (category_id IN (SELECT category_id FROM interest_categories)) DESC,
       featured DESC, best_seller DESC, sold_count DESC
     LIMIT 12`,
    [req.auth!.sub]
  );
  sendJson(res, 200, rows);
});

// Public like /exchange/wallets — the Customer App needs this to build the
// "Dial to Pay" USSD string before checkout, and the payment number/dial
// code here is meant to be dialed by anyone, not a secret.
shopRouter.get("/shop/payment-methods", async (_req, res) => {
  sendJson(res, 200, await query(`SELECT method, label, payment_number, ussd_template FROM shop_payment_methods ORDER BY method`));
});

// Public, read-only re-check of a cart against live prices/stock -- the
// Customer App calls this right before Checkout submits, so it can warn
// "this price changed" and ask the customer to confirm before dialing.
// Purely informational: POST /shop/orders itself already re-reads live
// prices and re-validates stock independently and always will, whether or
// not the client bothered to call this first.
shopRouter.post("/shop/cart/validate", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) return sendJson(res, 400, { error: "items is required" });
  const results = [];
  for (const raw of items) {
    const productId = String((raw as any)?.productId ?? "");
    const variantId = (raw as any)?.variantId ? String((raw as any).variantId) : null;
    const quantity = Number((raw as any)?.quantity);
    if (!productId || !Number.isInteger(quantity) || quantity < 1) {
      return sendJson(res, 400, { error: "Each item needs a valid productId and a quantity of at least 1" });
    }
    const product = await queryOne<{ price: string; stock: number; active: boolean; name: string }>(
      `SELECT shop_effective_price(id, price) AS price, stock, active, name FROM shop_products WHERE id=$1`,
      [productId]
    );
    let variantStock: number | null = null;
    let variantPrice: string | null = null;
    if (variantId && product) {
      const variant = await queryOne<{ price: string | null; stock: number }>(
        `SELECT price, stock FROM shop_product_variants WHERE id=$1 AND product_id=$2 AND active=true`,
        [variantId, productId]
      );
      if (!variant) {
        results.push({ productId, variantId, quantity, currentPrice: null, inStock: false, available: false, productName: product.name });
        continue;
      }
      variantStock = variant.stock;
      variantPrice = variant.price ?? product.price;
    }
    results.push({
      productId,
      variantId,
      quantity,
      currentPrice: product ? Number(variantPrice ?? product.price) : null,
      inStock: product ? (variantId ? (variantStock ?? 0) >= quantity : product.stock >= quantity) : false,
      available: Boolean(product?.active),
      productName: product?.name ?? null,
    });
  }
  sendJson(res, 200, { items: results });
});

type ShopSettingsRow = {
  delivery_fee: string;
  working_days: number[];
  opening_time: string;
  closing_time: string;
  manual_override: "open" | "closed" | null;
};

async function loadShopSettings(): Promise<ShopSettingsRow> {
  return (await queryOne<ShopSettingsRow>(`SELECT * FROM shop_settings WHERE id=true`))!;
}

// `now()`/CURRENT_TIME are evaluated in the session's own time zone, which
// pool.ts already pins to Africa/Mogadishu for every connection -- so this
// needs no timezone math of its own, just the day-of-week/time-of-day the
// database already hands back. EXTRACT(DOW ...) returns 0=Sunday..6=Saturday,
// matching workingDays' own convention.
async function resolveShopOpen(settings: ShopSettingsRow): Promise<boolean> {
  if (settings.manual_override) return settings.manual_override === "open";
  const now = await queryOne<{ dow: number; t: string }>(
    `SELECT EXTRACT(DOW FROM now())::int AS dow, now()::time AS t`
  );
  if (!now) return true;
  if (!settings.working_days.includes(now.dow)) return false;
  return now.t >= settings.opening_time && now.t <= settings.closing_time;
}

// Public -- the Customer App needs this both to show the 🟢/🔴 badge and to
// compute delivery fee at Checkout before placing an order.
shopRouter.get("/shop/settings", async (_req, res) => {
  const settings = await loadShopSettings();
  sendJson(res, 200, {
    isOpen: await resolveShopOpen(settings),
    deliveryFee: settings.delivery_fee,
    workingDays: settings.working_days,
    openingTime: settings.opening_time,
    closingTime: settings.closing_time,
    manualOverride: settings.manual_override,
  });
});

shopRouter.get("/admin/shop/settings", requirePermission("shop.manage"), async (_req, res) => {
  const settings = await loadShopSettings();
  sendJson(res, 200, { ...settings, isOpen: await resolveShopOpen(settings) });
});

const VALID_DOW = new Set([0, 1, 2, 3, 4, 5, 6]);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

shopRouter.put("/admin/shop/settings", requirePermission("shop.manage"), async (req, res) => {
  const { deliveryFee, workingDays, openingTime, closingTime, manualOverride } = req.body ?? {};
  if (deliveryFee !== undefined && (!Number.isFinite(Number(deliveryFee)) || Number(deliveryFee) < 0)) {
    return sendJson(res, 400, { error: "deliveryFee must be a non-negative number" });
  }
  if (workingDays !== undefined) {
    if (!Array.isArray(workingDays) || workingDays.length === 0 || !workingDays.every((d) => VALID_DOW.has(Number(d)))) {
      return sendJson(res, 400, { error: "workingDays must be a non-empty array of integers 0-6 (0=Sunday)" });
    }
  }
  if (openingTime !== undefined && !TIME_RE.test(openingTime)) {
    return sendJson(res, 400, { error: "openingTime must be in HH:MM (24-hour) form" });
  }
  if (closingTime !== undefined && !TIME_RE.test(closingTime)) {
    return sendJson(res, 400, { error: "closingTime must be in HH:MM (24-hour) form" });
  }
  if (manualOverride !== undefined && manualOverride !== null && !["open", "closed"].includes(manualOverride)) {
    return sendJson(res, 400, { error: "manualOverride must be 'open', 'closed', or null" });
  }
  const existing = await loadShopSettings();
  await query(
    `UPDATE shop_settings SET
       delivery_fee=$1, working_days=$2, opening_time=$3, closing_time=$4, manual_override=$5,
       updated_at=now(), updated_by=$6
     WHERE id=true`,
    [
      deliveryFee !== undefined ? Number(deliveryFee) : existing.delivery_fee,
      workingDays !== undefined ? workingDays.map(Number) : existing.working_days,
      openingTime ?? existing.opening_time,
      closingTime ?? existing.closing_time,
      manualOverride !== undefined ? manualOverride : existing.manual_override,
      req.auth!.sub,
    ]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "shop_settings_updated",
    entityType: "shop_settings",
    entityId: "shop_settings",
    oldValue: existing,
    newValue: { deliveryFee, workingDays, openingTime, closingTime, manualOverride },
  });
  const settings = await loadShopSettings();
  sendJson(res, 200, { ...settings, isOpen: await resolveShopOpen(settings) });
});

// ==================== Customer App (self-service) ====================

const SHOP_ORDER_COLUMNS = "id, customer_id, payment_method, sender_phone, delivery_name, delivery_phone, delivery_address, delivery_notes, delivery_zone_id, total_amount, delivery_fee, payment_status, status, tracking_reference, tracking_note, courier_name, is_gift, gift_recipient_name, gift_recipient_phone, gift_message, gift_wrap, paid_at, delivered_at, cancelled_at, created_at, updated_at";

async function loadOrderItems(orderId: string) {
  return query(
    `SELECT id, product_id, product_name, unit_price, quantity, subtotal, variant_id, variant_label, bundle_id, bundle_name
     FROM shop_order_items WHERE order_id=$1`,
    [orderId]
  );
}

async function loadOrderStatusHistory(orderId: string) {
  return query(`SELECT status, note, changed_at FROM shop_order_status_history WHERE order_id=$1 ORDER BY changed_at ASC`, [orderId]);
}

// Reverses whatever stock this order's items reserved at creation time --
// shared by the customer-initiated cancel route and the admin status route,
// since both need the exact same restoration for a plain product line, a
// specific variant, or every constituent product of a bundle line.
async function restoreShopOrderStock(orderId: string) {
  const items = await query<{ product_id: string | null; variant_id: string | null; bundle_id: string | null; quantity: number }>(
    `SELECT product_id, variant_id, bundle_id, quantity FROM shop_order_items WHERE order_id=$1`,
    [orderId]
  );
  for (const item of items) {
    if (item.bundle_id) {
      const bundleItems = await query<{ product_id: string; quantity: number }>(
        `SELECT product_id, quantity FROM shop_bundle_deal_items WHERE bundle_id=$1`,
        [item.bundle_id]
      );
      for (const bi of bundleItems) {
        await query(`UPDATE shop_products SET stock = stock + $1, updated_at = now() WHERE id=$2`, [bi.quantity * item.quantity, bi.product_id]);
      }
    } else if (item.variant_id) {
      await query(`UPDATE shop_product_variants SET stock = stock + $1, updated_at = now() WHERE id=$2`, [item.quantity, item.variant_id]);
    } else if (item.product_id) {
      await query(`UPDATE shop_products SET stock = stock + $1, updated_at = now() WHERE id=$2`, [item.quantity, item.product_id]);
    }
  }
}

// A deterministic signature of "what's being ordered" -- order-independent
// (sorted) so the same cart submitted twice always produces the same key
// regardless of item array order. Paired with the partial unique index on
// (customer_id, dedup_key) WHERE status='pending' from migration 077: a
// same-instant double-submit (the exact CheckoutScreen.kt-style incident
// migration 032 already fixed for Internet Store) hits that constraint and
// is treated as "return the order that already exists", never a second
// stock deduction.
type NormalizedShopItem =
  | { kind: "product"; productId: string; variantId: string | null; quantity: number }
  | { kind: "bundle"; bundleId: string; quantity: number };

function computeShopOrderDedupKey(items: NormalizedShopItem[], paymentMethod: string): string {
  const signature = items
    .map((i) => (i.kind === "bundle" ? `bundle:${i.bundleId}:${i.quantity}` : `${i.productId}:${i.variantId ?? ""}:${i.quantity}`))
    .sort()
    .join(",");
  return `${paymentMethod}|${signature}`;
}

shopRouter.post(
  "/shop/orders",
  requireAuth("customer"),
  rateLimit("customer-shop-order-create", 20, 15 * 60 * 1000),
  async (req, res) => {
    const {
      items,
      paymentMethod,
      senderPhone,
      deliveryName,
      deliveryPhone,
      deliveryAddress,
      deliveryNotes,
      deliveryZoneId,
      isGift,
      giftRecipientName,
      giftRecipientPhone,
      giftMessage,
      giftWrap,
    } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return sendJson(res, 400, { error: "Cart is empty — add at least one product" });
    }
    if (!senderPhone) return sendJson(res, 400, { error: "Provide the phone number you'll pay from" });
    if (!deliveryName || !deliveryPhone || !deliveryAddress) {
      return sendJson(res, 400, { error: "deliveryName, deliveryPhone, and deliveryAddress are all required" });
    }
    if (isGift && (!giftRecipientName || !giftRecipientPhone)) {
      return sendJson(res, 400, { error: "giftRecipientName and giftRecipientPhone are required for a gift order" });
    }
    // Closed means "browse only" per spec -- ordering is blocked at the API
    // layer too, not just hidden in the UI, matching how every other
    // server-side gate in this file works.
    const shopSettings = await loadShopSettings();
    if (!(await resolveShopOpen(shopSettings))) {
      return sendJson(res, 409, { error: "Shop is currently closed. Please check back during our working hours." });
    }
    const method = await queryOne<{ method: string; ussd_template: string }>(
      `SELECT method, ussd_template FROM shop_payment_methods WHERE method=$1`,
      [paymentMethod]
    );
    if (!method) return sendJson(res, 400, { error: "Choose a valid payment method" });

    // An optional delivery zone overrides shop_settings' single flat fee
    // with that zone's own -- additive, not a replacement: omitting
    // deliveryZoneId falls straight back to the flat fee, so nothing about
    // the existing flow changes for a customer who never picks a zone.
    let resolvedDeliveryFee = Number(shopSettings.delivery_fee);
    let resolvedZoneId: string | null = null;
    if (deliveryZoneId) {
      const zone = await queryOne<{ id: string; fee: string }>(
        `SELECT id, fee FROM shop_delivery_zones WHERE id=$1 AND active=true`,
        [deliveryZoneId]
      );
      if (!zone) return sendJson(res, 400, { error: "Selected delivery zone is no longer available" });
      resolvedDeliveryFee = Number(zone.fee);
      resolvedZoneId = zone.id;
    }

    // Same carrier-prefix discipline every other purchase flow in this app
    // already enforces -- a customer claiming to pay via EVC Plus must
    // actually be dialing from an EVC Plus-prefixed number, since that's
    // the number the incoming payment confirmation will need to match.
    // shop_payment_methods.method ('evc'/'edahab') maps 1:1 onto
    // phoneValidation's company keys except 'evc' -> 'evc_plus'.
    const senderCompanyKey = method.method === "evc" ? "evc_plus" : method.method;
    const senderCheck = validateMobileNumber(String(senderPhone), senderCompanyKey);
    if (!senderCheck.valid) return sendJson(res, 400, { error: senderCheck.error });
    const deliveryCheck = validateMobileNumber(String(deliveryPhone));
    if (!deliveryCheck.valid) return sendJson(res, 400, { error: deliveryCheck.error });

    // Normalized up front (not just inside the transaction) so a stable
    // dedup signature can be computed before any stock is touched. Each
    // cart line is either a plain product (optionally a specific variant)
    // or a bundle deal -- never both.
    const normalizedItems: NormalizedShopItem[] = [];
    for (const raw of items) {
      const quantity = Number((raw as any)?.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) {
        return sendJson(res, 400, { error: "Each cart item needs a quantity of at least 1" });
      }
      const bundleId = (raw as any)?.bundleId ? String((raw as any).bundleId) : null;
      if (bundleId) {
        normalizedItems.push({ kind: "bundle", bundleId, quantity });
        continue;
      }
      const productId = String((raw as any)?.productId ?? "");
      if (!productId) {
        return sendJson(res, 400, { error: "Each cart item needs a valid productId (or bundleId) and a quantity of at least 1" });
      }
      const variantId = (raw as any)?.variantId ? String((raw as any).variantId) : null;
      normalizedItems.push({ kind: "product", productId, variantId, quantity });
    }
    const dedupKey = computeShopOrderDedupKey(normalizedItems, method.method);

    try {
      const result = await withTransaction(async (client) => {
        // Same cart + same payment method, still pending from a moment ago
        // (a double-tap on Checkout) -- return that order rather than
        // deducting stock a second time. Checked before any row lock/stock
        // mutation below; the partial unique index still exists as the
        // race-safe backstop if two requests somehow both reach here at once
        // (the loser's whole transaction, stock deduction included, rolls
        // back on the unique-violation and is retried by the client as a
        // normal error, not silently double-counted).
        const dup = await client.query(
          `SELECT id FROM shop_orders WHERE customer_id=$1 AND dedup_key=$2 AND status='pending' LIMIT 1`,
          [req.auth!.sub, dedupKey]
        );
        if (dup.rows[0]) return { orderId: dup.rows[0].id as string, duplicate: true };

        const orderId = generateShopOrderId();
        let total = 0;
        const orderItems: {
          productId: string | null;
          productName: string;
          unitPrice: number;
          quantity: number;
          subtotal: number;
          variantId: string | null;
          variantLabel: string | null;
          bundleId: string | null;
          bundleName: string | null;
        }[] = [];

        for (const item of normalizedItems) {
          if (item.kind === "bundle") {
            // FOR UPDATE on the bundle row itself guards against an Admin
            // deactivating/deleting it mid-checkout; each constituent
            // product is separately locked below, same as a plain product
            // line, before its stock is touched.
            const bundle = await client.query(`SELECT id, name, bundle_price, active FROM shop_bundle_deals WHERE id=$1 FOR UPDATE`, [item.bundleId]);
            const bundleRow = bundle.rows[0];
            if (!bundleRow || !bundleRow.active) {
              throw Object.assign(new Error(`This bundle deal is no longer available`), { status: 404 });
            }
            const bundleItems = await client.query(`SELECT product_id, quantity FROM shop_bundle_deal_items WHERE bundle_id=$1`, [item.bundleId]);
            if (bundleItems.rows.length === 0) {
              throw Object.assign(new Error(`This bundle deal has no products configured`), { status: 409 });
            }
            for (const bi of bundleItems.rows) {
              const needed = bi.quantity * item.quantity;
              const product = await client.query(`SELECT id, name, stock, active FROM shop_products WHERE id=$1 FOR UPDATE`, [bi.product_id]);
              const row = product.rows[0];
              if (!row || !row.active) {
                throw Object.assign(new Error(`A product in this bundle is no longer available`), { status: 404 });
              }
              if (row.stock < needed) {
                throw Object.assign(new Error(`Only ${row.stock} of "${row.name}" left in stock for this bundle`), { status: 409 });
              }
              await client.query(
                `UPDATE shop_products SET stock = stock - $1, sold_count = sold_count + $1, updated_at = now() WHERE id=$2`,
                [needed, bi.product_id]
              );
            }
            const unitPrice = Number(bundleRow.bundle_price);
            const subtotal = Math.round(unitPrice * item.quantity * 100) / 100;
            total = Math.round((total + subtotal) * 100) / 100;
            orderItems.push({
              productId: null,
              productName: bundleRow.name,
              unitPrice,
              quantity: item.quantity,
              subtotal,
              variantId: null,
              variantLabel: null,
              bundleId: item.bundleId,
              bundleName: bundleRow.name,
            });
            continue;
          }

          const { productId, variantId, quantity } = item;
          // FOR UPDATE: two customers checking out the same low-stock product
          // at once must never both succeed past the stock check below —
          // same "lock the candidate row before touching it" principle used
          // throughout this codebase's other reservation flows. price is
          // resolved through shop_effective_price() here too, so a Flash
          // Sale price is what's actually charged, matching what
          // POST /shop/cart/validate and the catalog already showed.
          const product = await client.query(
            `SELECT id, name, shop_effective_price(id, price) AS price, stock, active FROM shop_products WHERE id=$1 FOR UPDATE`,
            [productId]
          );
          const row = product.rows[0];
          if (!row || !row.active) {
            throw Object.assign(new Error(`Product ${productId} is no longer available`), { status: 404 });
          }

          let unitPrice: number;
          let variantLabel: string | null = null;
          if (variantId) {
            const variant = await client.query(
              `SELECT id, label, price, stock, active FROM shop_product_variants WHERE id=$1 AND product_id=$2 FOR UPDATE`,
              [variantId, productId]
            );
            const vrow = variant.rows[0];
            if (!vrow || !vrow.active) {
              throw Object.assign(new Error(`Selected option for "${row.name}" is no longer available`), { status: 404 });
            }
            if (vrow.stock < quantity) {
              throw Object.assign(new Error(`Only ${vrow.stock} of "${row.name}" (${vrow.label}) left in stock`), { status: 409 });
            }
            await client.query(`UPDATE shop_product_variants SET stock = stock - $1, updated_at = now() WHERE id=$2`, [quantity, variantId]);
            await client.query(`UPDATE shop_products SET sold_count = sold_count + $1, updated_at = now() WHERE id=$2`, [quantity, productId]);
            unitPrice = vrow.price != null ? Number(vrow.price) : Number(row.price);
            variantLabel = vrow.label;
          } else {
            if (row.stock < quantity) {
              throw Object.assign(new Error(`Only ${row.stock} of "${row.name}" left in stock`), { status: 409 });
            }
            await client.query(
              `UPDATE shop_products SET stock = stock - $1, sold_count = sold_count + $1, updated_at = now() WHERE id=$2`,
              [quantity, productId]
            );
            unitPrice = Number(row.price);
          }

          const subtotal = Math.round(unitPrice * quantity * 100) / 100;
          total = Math.round((total + subtotal) * 100) / 100;
          orderItems.push({
            productId,
            productName: row.name,
            unitPrice,
            quantity,
            subtotal,
            variantId: variantId ?? null,
            variantLabel,
            bundleId: null,
            bundleName: null,
          });
        }

        total = Math.round((total + resolvedDeliveryFee) * 100) / 100;

        await client.query(
          `INSERT INTO shop_orders (
             id, customer_id, payment_method, sender_phone, delivery_name, delivery_phone, delivery_address, delivery_notes, delivery_zone_id,
             total_amount, delivery_fee, dedup_key, is_gift, gift_recipient_name, gift_recipient_phone, gift_message, gift_wrap
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            orderId,
            req.auth!.sub,
            method.method,
            senderPhone,
            deliveryName,
            deliveryPhone,
            deliveryAddress,
            typeof deliveryNotes === "string" ? deliveryNotes.trim() || null : null,
            resolvedZoneId,
            total,
            resolvedDeliveryFee,
            dedupKey,
            Boolean(isGift),
            isGift ? String(giftRecipientName).trim() : null,
            isGift ? String(giftRecipientPhone).trim() : null,
            isGift && typeof giftMessage === "string" ? giftMessage.trim() || null : null,
            Boolean(isGift && giftWrap),
          ]
        );
        for (const item of orderItems) {
          await client.query(
            `INSERT INTO shop_order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal, variant_id, variant_label, bundle_id, bundle_name)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              randomUUID(),
              orderId,
              item.productId,
              item.productName,
              item.unitPrice,
              item.quantity,
              item.subtotal,
              item.variantId,
              item.variantLabel,
              item.bundleId,
              item.bundleName,
            ]
          );
        }
        await client.query(`INSERT INTO shop_order_status_history (order_id, status) VALUES ($1,'pending')`, [orderId]);
        return { orderId, duplicate: false };
      });

      const order = await queryOne<{ total_amount: string }>(`SELECT ${SHOP_ORDER_COLUMNS} FROM shop_orders WHERE id=$1`, [result.orderId]);
      // formatUssdAmount converts the decimal total into the dollars[*cents]
      // segments every provider's USSD menu actually expects -- "." isn't a
      // valid USSD/MMI dial character, so a raw "49.99" would silently
      // produce a malformed dial string (see ussdFormatting.ts's own header
      // comment for the real production incident this same bug caused for
      // Internet Store before it was fixed).
      const dialUssd = method.ussd_template.replace("{amount}", formatUssdAmount(Number(order!.total_amount)));
      sendJson(res, result.duplicate ? 200 : 201, { ...order, items: await loadOrderItems(result.orderId), dialUssd });
    } catch (err: any) {
      if (err?.status) return sendJson(res, err.status, { error: err.message });
      throw err;
    }
  }
);

// Capped at 100 — same unbounded-list fix every other order-history route
// in this codebase already applies.
shopRouter.get("/shop/orders", requireAuth("customer"), async (req, res) => {
  const orders = await query(`SELECT ${SHOP_ORDER_COLUMNS} FROM shop_orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.auth!.sub]);
  sendJson(res, 200, orders);
});

shopRouter.get("/shop/orders/:id", requireAuth("customer"), async (req, res) => {
  const order = await queryOne(`SELECT ${SHOP_ORDER_COLUMNS} FROM shop_orders WHERE id=$1 AND customer_id=$2`, [req.params.id, req.auth!.sub]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, { ...order, items: await loadOrderItems(order.id), statusHistory: await loadOrderStatusHistory(order.id) });
});

// Customer-initiated -- only while the order is still pending AND unpaid,
// per spec: once payment is confirmed, the order moves into the agent's
// fulfillment queue (Processing) and the customer can no longer back out of
// it themselves. Reuses the exact same "give the reserved stock back" step
// the admin status route already applies for cancelled/failed/returned; the
// dedup partial unique index (WHERE status='pending') is naturally freed
// up too, so the same cart could be re-ordered afterward without hitting
// a stale duplicate match.
shopRouter.post("/shop/orders/:id/cancel", requireAuth("customer"), async (req, res) => {
  const order = await queryOne<{ status: string; payment_status: string }>(
    `SELECT status, payment_status FROM shop_orders WHERE id=$1 AND customer_id=$2`,
    [req.params.id, req.auth!.sub]
  );
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  if (order.status !== "pending" || order.payment_status === "paid") {
    return sendJson(res, 409, { error: "This order can no longer be cancelled — payment has been confirmed and it is now being processed" });
  }
  await restoreShopOrderStock(req.params.id);
  await query(`UPDATE shop_orders SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1`, [req.params.id]);
  await query(`INSERT INTO shop_order_status_history (order_id, status, note) VALUES ($1,'cancelled','Cancelled by customer')`, [req.params.id]);
  await recordActivity({
    adminId: undefined,
    action: "shop_order_cancelled_by_customer",
    entityType: "shop_order",
    entityId: req.params.id,
    oldValue: { status: order.status },
    newValue: { status: "cancelled" },
  });
  sendJson(res, 200, await queryOne(`SELECT ${SHOP_ORDER_COLUMNS} FROM shop_orders WHERE id=$1`, [req.params.id]));
});

// Re-issues the dial string for an existing order that failed/timed out
// at the phone's own dialer -- never creates a second order or touches
// stock (already reserved once, at creation time). Only while payment
// hasn't been confirmed and the order hasn't moved past 'processing':
// once stock has been given back (a terminal/failed/returned state) the
// original reservation this dial string was for no longer holds, and once
// paid there's nothing left to retry. Recomputes from the payment
// method's current ussd_template rather than trusting anything cached,
// in case Admin has repointed the collection number since the order was
// placed.
shopRouter.post("/shop/orders/:id/retry-payment", requireAuth("customer"), async (req, res) => {
  const order = await queryOne<{ status: string; payment_status: string; payment_method: string; total_amount: string }>(
    `SELECT status, payment_status, payment_method, total_amount FROM shop_orders WHERE id=$1 AND customer_id=$2`,
    [req.params.id, req.auth!.sub]
  );
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  if (order.payment_status === "paid") return sendJson(res, 409, { error: "This order has already been paid" });
  if (!["pending", "processing"].includes(order.status)) {
    return sendJson(res, 409, { error: "This order can no longer be retried — please contact support" });
  }
  const method = await queryOne<{ ussd_template: string }>(`SELECT ussd_template FROM shop_payment_methods WHERE method=$1`, [order.payment_method]);
  if (!method) return sendJson(res, 409, { error: "The payment method on this order is no longer available — please contact support" });
  const dialUssd = method.ussd_template.replace("{amount}", formatUssdAmount(Number(order.total_amount)));
  sendJson(res, 200, { dialUssd });
});

// ==================== Favorites / Wishlist ====================

// PRODUCT_COLUMNS' own (unqualified) created_at collides with
// shop_favorites' once both tables are in scope, so the "when favorited"
// ordering is a scalar subquery instead of a JOIN column -- same
// no-ambiguity reasoning as the avg_rating/review_count subqueries above.
shopRouter.get("/shop/favorites", requireAuth("customer"), async (req, res) => {
  const rows = await query(
    `SELECT ${PRODUCT_COLUMNS} FROM shop_products
     WHERE id IN (SELECT product_id FROM shop_favorites WHERE customer_id=$1)
     ORDER BY (SELECT created_at FROM shop_favorites WHERE customer_id=$1 AND product_id=shop_products.id) DESC`,
    [req.auth!.sub]
  );
  sendJson(res, 200, rows);
});

shopRouter.post("/shop/favorites", requireAuth("customer"), async (req, res) => {
  const productId = String(req.body?.productId ?? "");
  if (!productId) return sendJson(res, 400, { error: "productId is required" });
  if (!(await queryOne(`SELECT id FROM shop_products WHERE id=$1`, [productId]))) {
    return sendJson(res, 404, { error: "Product not found" });
  }
  await query(
    `INSERT INTO shop_favorites (customer_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [req.auth!.sub, productId]
  );
  sendJson(res, 201, { favorited: true });
});

shopRouter.delete("/shop/favorites/:productId", requireAuth("customer"), async (req, res) => {
  await query(`DELETE FROM shop_favorites WHERE customer_id=$1 AND product_id=$2`, [req.auth!.sub, req.params.productId]);
  sendJson(res, 200, { favorited: false });
});

// ==================== Reviews & Ratings ====================

// Public -- Product Detail shows every review for a product, no auth
// needed to read them (same as the catalog itself).
shopRouter.get("/shop/products/:id/reviews", async (req, res) => {
  const rows = await query(
    `SELECT r.id, r.rating, r.review_text, (r.photo_data IS NOT NULL) AS has_photo, r.created_at, c.name AS customer_name
     FROM shop_reviews r JOIN customers c ON c.id = r.customer_id
     WHERE r.product_id=$1 ORDER BY r.created_at DESC LIMIT 200`,
    [req.params.id]
  );
  sendJson(res, 200, rows);
});

shopRouter.get("/shop/reviews/:id/photo", async (req, res) => {
  const row = await queryOne<{ photo_data: Buffer | null; photo_mime_type: string | null }>(
    `SELECT photo_data, photo_mime_type FROM shop_reviews WHERE id=$1`,
    [req.params.id]
  );
  if (!row || !row.photo_data) return sendJson(res, 404, { error: "Photo not found" });
  res.setHeader("Content-Type", row.photo_mime_type ?? "application/octet-stream");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(row.photo_data);
});

// Purchase-gated per spec: orderItemId must belong to one of this
// customer's own DELIVERED orders. Re-checked server-side regardless of
// what the Customer App only shows a "Write a review" button for --
// order_item_id's UNIQUE constraint below is the actual, race-safe
// enforcement of "one review per purchase", not just this SELECT.
shopRouter.post("/shop/reviews", requireAuth("customer"), async (req, res) => {
  const orderItemId = String(req.body?.orderItemId ?? "");
  const rating = Number(req.body?.rating);
  const reviewText = typeof req.body?.reviewText === "string" ? req.body.reviewText.trim() : "";
  if (!orderItemId) return sendJson(res, 400, { error: "orderItemId is required" });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return sendJson(res, 400, { error: "rating must be a whole number from 1 to 5" });
  }
  const item = await queryOne<{ product_id: string | null; customer_id: string; status: string }>(
    `SELECT oi.product_id, o.customer_id, o.status
     FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
     WHERE oi.id=$1`,
    [orderItemId]
  );
  if (!item || item.customer_id !== req.auth!.sub) return sendJson(res, 404, { error: "Order item not found" });
  if (item.status !== "delivered") return sendJson(res, 403, { error: "You can only review products from a delivered order" });
  if (!item.product_id) return sendJson(res, 409, { error: "This product no longer exists" });

  let photo: { data: Buffer; mimeType: string } | null = null;
  if (req.body?.photoBase64) {
    const parsed = parseDataUri(req.body.photoBase64);
    if (!parsed) return sendJson(res, 400, { error: "photoBase64 must be a data:<mime>;base64,<data> string" });
    photo = parsed;
  }

  try {
    const id = randomUUID();
    await query(
      `INSERT INTO shop_reviews (id, order_item_id, product_id, customer_id, rating, review_text, photo_data, photo_mime_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, orderItemId, item.product_id, req.auth!.sub, rating, reviewText, photo?.data ?? null, photo?.mimeType ?? null]
    );
    sendJson(res, 201, { id });
  } catch (err: any) {
    if (err?.code === "23505") return sendJson(res, 409, { error: "You've already reviewed this purchase" });
    throw err;
  }
});

// ==================== Returns / Exchange / Refund requests ====================

const RETURN_TYPES = ["return", "exchange", "refund"];
const RETURN_STATUSES = ["requested", "approved", "rejected", "processing", "completed"];
const RETURN_TERMINAL = ["rejected", "completed"];
// Sequential per spec -- no skipping straight from 'requested' to
// 'completed', matching the exact Requested -> Approved/Rejected ->
// Processing -> Completed flow it describes.
const RETURN_TRANSITIONS: Record<string, string[]> = {
  requested: ["approved", "rejected"],
  approved: ["processing"],
  processing: ["completed"],
};

shopRouter.post("/shop/returns", requireAuth("customer"), async (req, res) => {
  const orderId = String(req.body?.orderId ?? "");
  const type = String(req.body?.type ?? "");
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!RETURN_TYPES.includes(type)) return sendJson(res, 400, { error: `type must be one of ${RETURN_TYPES.join(", ")}` });
  const order = await queryOne<{ status: string; customer_id: string }>(`SELECT status, customer_id FROM shop_orders WHERE id=$1`, [orderId]);
  if (!order || order.customer_id !== req.auth!.sub) return sendJson(res, 404, { error: "Order not found" });
  if (order.status !== "delivered") {
    return sendJson(res, 403, { error: "Only a delivered order can have a return, exchange, or refund requested" });
  }
  try {
    const id = randomUUID();
    await query(`INSERT INTO shop_return_requests (id, order_id, customer_id, type, reason) VALUES ($1,$2,$3,$4,$5)`, [
      id,
      orderId,
      req.auth!.sub,
      type,
      reason,
    ]);
    sendJson(res, 201, await queryOne(`SELECT * FROM shop_return_requests WHERE id=$1`, [id]));
  } catch (err: any) {
    if (err?.code === "23505") return sendJson(res, 409, { error: "This order already has an active return/exchange/refund request" });
    throw err;
  }
});

shopRouter.get("/shop/returns", requireAuth("customer"), async (req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM shop_return_requests WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.auth!.sub]));
});

shopRouter.get("/shop/returns/:id", requireAuth("customer"), async (req, res) => {
  const row = await queryOne(`SELECT * FROM shop_return_requests WHERE id=$1 AND customer_id=$2`, [req.params.id, req.auth!.sub]);
  if (!row) return sendJson(res, 404, { error: "Request not found" });
  sendJson(res, 200, row);
});

// ==================== Delivery Addresses ====================
//
// Checkout picks one of these and copies its fields into the same
// deliveryName/Phone/Address POST /shop/orders already accepts -- that
// route itself needs no change, an address book is purely a Customer App
// convenience layered on top of it.

shopRouter.get("/shop/addresses", requireAuth("customer"), async (req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM shop_delivery_addresses WHERE customer_id=$1 ORDER BY is_default DESC, created_at DESC`, [req.auth!.sub]));
});

async function clearOtherDefaultAddresses(customerId: string, exceptId?: string) {
  await query(
    `UPDATE shop_delivery_addresses SET is_default=false, updated_at=now() WHERE customer_id=$1 AND is_default=true AND id != COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [customerId, exceptId ?? null]
  );
}

shopRouter.post("/shop/addresses", requireAuth("customer"), async (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  const recipientName = String(req.body?.recipientName ?? "").trim();
  const phone = String(req.body?.phone ?? "").trim();
  const addressText = String(req.body?.addressText ?? "").trim();
  const isDefault = Boolean(req.body?.isDefault);
  if (!recipientName || !phone || !addressText) {
    return sendJson(res, 400, { error: "recipientName, phone, and addressText are all required" });
  }
  const id = randomUUID();
  await withTransaction(async (client) => {
    // First saved address becomes the default automatically, same as
    // ticking "make default" -- a customer with exactly one address
    // should never have to think about this toggle.
    const existingCount = await client.query(`SELECT COUNT(*) AS n FROM shop_delivery_addresses WHERE customer_id=$1`, [req.auth!.sub]);
    const makeDefault = isDefault || Number(existingCount.rows[0]?.n ?? 0) === 0;
    if (makeDefault) {
      await client.query(`UPDATE shop_delivery_addresses SET is_default=false, updated_at=now() WHERE customer_id=$1 AND is_default=true`, [req.auth!.sub]);
    }
    await client.query(
      `INSERT INTO shop_delivery_addresses (id, customer_id, label, recipient_name, phone, address_text, is_default) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, req.auth!.sub, label, recipientName, phone, addressText, makeDefault]
    );
  });
  sendJson(res, 201, await queryOne(`SELECT * FROM shop_delivery_addresses WHERE id=$1`, [id]));
});

shopRouter.put("/shop/addresses/:id", requireAuth("customer"), async (req, res) => {
  const existing = await queryOne<{ id: string }>(`SELECT id FROM shop_delivery_addresses WHERE id=$1 AND customer_id=$2`, [req.params.id, req.auth!.sub]);
  if (!existing) return sendJson(res, 404, { error: "Address not found" });
  const { label, recipientName, phone, addressText, isDefault } = req.body ?? {};
  if (isDefault === true) await clearOtherDefaultAddresses(req.auth!.sub, req.params.id);
  await query(
    `UPDATE shop_delivery_addresses SET
       label=COALESCE($1, label), recipient_name=COALESCE($2, recipient_name), phone=COALESCE($3, phone),
       address_text=COALESCE($4, address_text), is_default=COALESCE($5, is_default), updated_at=now()
     WHERE id=$6`,
    [
      typeof label === "string" ? label.trim() : null,
      typeof recipientName === "string" ? recipientName.trim() || null : null,
      typeof phone === "string" ? phone.trim() || null : null,
      typeof addressText === "string" ? addressText.trim() || null : null,
      typeof isDefault === "boolean" ? isDefault : null,
      req.params.id,
    ]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM shop_delivery_addresses WHERE id=$1`, [req.params.id]));
});

shopRouter.delete("/shop/addresses/:id", requireAuth("customer"), async (req, res) => {
  const result = await query(`DELETE FROM shop_delivery_addresses WHERE id=$1 AND customer_id=$2 RETURNING id`, [req.params.id, req.auth!.sub]);
  if (result.length === 0) return sendJson(res, 404, { error: "Address not found" });
  sendJson(res, 200, { deleted: true });
});

// ==================== Admin: Categories ====================

shopRouter.get("/admin/shop/categories", requirePermission("shop.manage"), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT ${CATEGORY_COLUMNS} FROM shop_categories ORDER BY position`));
});

shopRouter.post("/admin/shop/categories", requirePermission("shop.manage"), async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const emoji = String(req.body?.emoji ?? "").trim();
  if (!name) return sendJson(res, 400, { error: "name is required" });
  const maxPos = await queryOne<{ m: number }>(`SELECT COALESCE(MAX(position), 0) AS m FROM shop_categories`);
  try {
    const id = randomUUID();
    await query(`INSERT INTO shop_categories (id, name, emoji, position) VALUES ($1,$2,$3,$4)`, [id, name, emoji, (maxPos?.m ?? 0) + 1]);
    sendJson(res, 201, await queryOne(`SELECT ${CATEGORY_COLUMNS} FROM shop_categories WHERE id=$1`, [id]));
  } catch (err: any) {
    if (err?.code === "23505") return sendJson(res, 409, { error: "A category with this name already exists" });
    throw err;
  }
});

shopRouter.put("/admin/shop/categories/:id", requirePermission("shop.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM shop_categories WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Category not found" });
  const { name, emoji, active, position } = req.body ?? {};
  try {
    await query(
      `UPDATE shop_categories SET name=COALESCE($1, name), emoji=COALESCE($2, emoji), active=COALESCE($3, active), position=COALESCE($4, position), updated_at=now() WHERE id=$5`,
      [name?.trim() || null, typeof emoji === "string" ? emoji : null, typeof active === "boolean" ? active : null, typeof position === "number" ? position : null, req.params.id]
    );
    sendJson(res, 200, await queryOne(`SELECT ${CATEGORY_COLUMNS} FROM shop_categories WHERE id=$1`, [req.params.id]));
  } catch (err: any) {
    if (err?.code === "23505") return sendJson(res, 409, { error: "A category with this name already exists" });
    throw err;
  }
});

// A category with products under it can't be hard-deleted (products.category_id
// is ON DELETE RESTRICT — history/reporting must never lose its category
// label) — deactivate it instead so it disappears from the Customer App
// while its products keep a valid category_id.
shopRouter.delete("/admin/shop/categories/:id", requirePermission("shop.manage"), async (req, res) => {
  try {
    const result = await query(`DELETE FROM shop_categories WHERE id=$1 RETURNING id`, [req.params.id]);
    if (result.length === 0) return sendJson(res, 404, { error: "Category not found" });
    sendJson(res, 200, { deleted: true });
  } catch (err: any) {
    if (err?.code === "23503") {
      return sendJson(res, 409, { error: "This category still has products — deactivate it instead, or move/delete its products first" });
    }
    throw err;
  }
});

// One image per category (unlike shop_product_images' gallery) -- PUT
// always replaces whatever was there, matching packages.routes.ts's own
// PUT-based single-image pattern.
shopRouter.put("/admin/shop/categories/:id/image", requirePermission("shop.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM shop_categories WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Category not found" });
  const parsed = parseDataUri(req.body?.imageBase64);
  if (!parsed) return sendJson(res, 400, { error: "imageBase64 must be a data:<mime>;base64,<data> string" });
  if (!parsed.mimeType.startsWith("image/")) {
    return sendJson(res, 400, { error: "Only image files are allowed — no video" });
  }
  await query(`UPDATE shop_categories SET image_data=$1, image_mime_type=$2, updated_at=now() WHERE id=$3`, [parsed.data, parsed.mimeType, req.params.id]);
  sendJson(res, 200, await queryOne(`SELECT ${CATEGORY_COLUMNS} FROM shop_categories WHERE id=$1`, [req.params.id]));
});

// Reverts the category to its emoji -- the Customer App and admin card both
// already fall back to it whenever has_image is false.
shopRouter.delete("/admin/shop/categories/:id/image", requirePermission("shop.manage"), async (req, res) => {
  const result = await query(`UPDATE shop_categories SET image_data=NULL, image_mime_type=NULL, updated_at=now() WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Category not found" });
  sendJson(res, 200, await queryOne(`SELECT ${CATEGORY_COLUMNS} FROM shop_categories WHERE id=$1`, [req.params.id]));
});

// ==================== Admin: Subcategories ====================

shopRouter.get("/admin/shop/subcategories", requirePermission("shop.manage"), async (req, res) => {
  const { categoryId } = req.query;
  const rows = categoryId
    ? await query(`SELECT ${SUBCATEGORY_COLUMNS} FROM shop_subcategories WHERE category_id=$1 ORDER BY position`, [categoryId])
    : await query(`SELECT ${SUBCATEGORY_COLUMNS} FROM shop_subcategories ORDER BY position`);
  sendJson(res, 200, rows);
});

shopRouter.post("/admin/shop/subcategories", requirePermission("shop.manage"), async (req, res) => {
  const categoryId = String(req.body?.categoryId ?? "");
  const name = String(req.body?.name ?? "").trim();
  if (!categoryId || !name) return sendJson(res, 400, { error: "categoryId and name are required" });
  if (!(await queryOne(`SELECT id FROM shop_categories WHERE id=$1`, [categoryId]))) {
    return sendJson(res, 404, { error: "Category not found" });
  }
  const maxPos = await queryOne<{ m: number }>(`SELECT COALESCE(MAX(position), 0) AS m FROM shop_subcategories WHERE category_id=$1`, [categoryId]);
  try {
    const id = randomUUID();
    await query(`INSERT INTO shop_subcategories (id, category_id, name, position) VALUES ($1,$2,$3,$4)`, [id, categoryId, name, (maxPos?.m ?? 0) + 1]);
    sendJson(res, 201, await queryOne(`SELECT ${SUBCATEGORY_COLUMNS} FROM shop_subcategories WHERE id=$1`, [id]));
  } catch (err: any) {
    if (err?.code === "23505") return sendJson(res, 409, { error: "A subcategory with this name already exists in this category" });
    throw err;
  }
});

shopRouter.put("/admin/shop/subcategories/:id", requirePermission("shop.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM shop_subcategories WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Subcategory not found" });
  const { name, active, position } = req.body ?? {};
  try {
    await query(
      `UPDATE shop_subcategories SET name=COALESCE($1, name), active=COALESCE($2, active), position=COALESCE($3, position), updated_at=now() WHERE id=$4`,
      [name?.trim() || null, typeof active === "boolean" ? active : null, typeof position === "number" ? position : null, req.params.id]
    );
    sendJson(res, 200, await queryOne(`SELECT ${SUBCATEGORY_COLUMNS} FROM shop_subcategories WHERE id=$1`, [req.params.id]));
  } catch (err: any) {
    if (err?.code === "23505") return sendJson(res, 409, { error: "A subcategory with this name already exists in this category" });
    throw err;
  }
});

// A subcategory with products under it can't be deleted -- deactivate it
// instead, same reasoning as categories (products.subcategory_id is ON
// DELETE SET NULL, but silently orphaning a product's subcategory on a
// Delete click would be a surprising side effect, so this blocks it
// explicitly rather than relying on the FK action).
shopRouter.delete("/admin/shop/subcategories/:id", requirePermission("shop.manage"), async (req, res) => {
  const inUse = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM shop_products WHERE subcategory_id=$1`, [req.params.id]);
  if (Number(inUse?.n ?? 0) > 0) {
    return sendJson(res, 409, { error: "This subcategory still has products — deactivate it instead, or move/delete its products first" });
  }
  const result = await query(`DELETE FROM shop_subcategories WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Subcategory not found" });
  sendJson(res, 200, { deleted: true });
});

// ==================== Admin: Products ====================

shopRouter.get("/admin/shop/products", requirePermission("shop.manage"), async (req, res) => {
  const { categoryId, subcategoryId, search } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `SELECT ${PRODUCT_COLUMNS} FROM shop_products WHERE 1=1`;
  if (categoryId) { args.push(categoryId); sql += ` AND category_id=$${args.length}`; }
  if (subcategoryId) { args.push(subcategoryId); sql += ` AND subcategory_id=$${args.length}`; }
  if (search) { args.push(`%${search}%`); sql += ` AND name ILIKE $${args.length}`; }
  sql += ` ORDER BY created_at DESC`;
  sendJson(res, 200, await query(sql, args));
});

// Registered before the generic /admin/shop/products/:id below -- same
// "literal path before dynamic" ordering fix as
// GET /shop/products/recently-viewed above: every active product at or
// below its own low_stock_threshold, the dashboard list an Admin checks
// rather than a push notification pipeline this app has no admin-device
// registration for (see migration 085).
shopRouter.get("/admin/shop/products/low-stock", requirePermission("shop.manage"), async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT ${PRODUCT_COLUMNS}, low_stock_threshold FROM shop_products WHERE active=true AND stock <= low_stock_threshold ORDER BY stock ASC`
    )
  );
});

shopRouter.get("/admin/shop/products/:id", requirePermission("shop.manage"), async (req, res) => {
  const product = await queryOne<any>(`SELECT ${PRODUCT_COLUMNS}, low_stock_threshold FROM shop_products WHERE id=$1`, [req.params.id]);
  if (!product) return sendJson(res, 404, { error: "Product not found" });
  const images = await query(`SELECT id, position FROM shop_product_images WHERE product_id=$1 ORDER BY position`, [req.params.id]);
  const variants = await query(`SELECT ${VARIANT_COLUMNS} FROM shop_product_variants WHERE product_id=$1 ORDER BY position`, [req.params.id]);
  sendJson(res, 200, { ...product, images, variants });
});

shopRouter.post("/admin/shop/products", requirePermission("shop.manage"), async (req, res) => {
  const { categoryId, subcategoryId, name, description, price, oldPrice, stock, brand, featured, isNewArrival, bestSeller, lowStockThreshold } = req.body ?? {};
  if (!categoryId || !name) return sendJson(res, 400, { error: "categoryId and name are required" });
  const priceNum = Number(price);
  const stockNum = stock == null ? 0 : Number(stock);
  if (!Number.isFinite(priceNum) || priceNum < 0) return sendJson(res, 400, { error: "price must be a non-negative number" });
  if (!Number.isInteger(stockNum) || stockNum < 0) return sendJson(res, 400, { error: "stock must be a non-negative whole number" });
  if (oldPrice !== undefined && oldPrice !== null && oldPrice !== "" && (!Number.isFinite(Number(oldPrice)) || Number(oldPrice) < 0)) {
    return sendJson(res, 400, { error: "oldPrice must be a non-negative number" });
  }
  if (!(await queryOne(`SELECT id FROM shop_categories WHERE id=$1`, [categoryId]))) {
    return sendJson(res, 404, { error: "Category not found" });
  }
  if (subcategoryId) {
    const sub = await queryOne<{ category_id: string }>(`SELECT category_id FROM shop_subcategories WHERE id=$1`, [subcategoryId]);
    if (!sub) return sendJson(res, 404, { error: "Subcategory not found" });
    if (sub.category_id !== categoryId) return sendJson(res, 400, { error: "Subcategory does not belong to the selected category" });
  }
  const id = randomUUID();
  await query(
    `INSERT INTO shop_products (id, category_id, subcategory_id, name, description, price, old_price, stock, brand, featured, is_new_arrival, best_seller, low_stock_threshold)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      categoryId,
      subcategoryId || null,
      String(name).trim(),
      String(description ?? "").trim(),
      priceNum,
      oldPrice !== undefined && oldPrice !== null && oldPrice !== "" ? Number(oldPrice) : null,
      stockNum,
      String(brand ?? "").trim(),
      Boolean(featured),
      Boolean(isNewArrival),
      Boolean(bestSeller),
      lowStockThreshold != null && Number.isInteger(Number(lowStockThreshold)) && Number(lowStockThreshold) >= 0 ? Number(lowStockThreshold) : 5,
    ]
  );
  sendJson(res, 201, await queryOne(`SELECT ${PRODUCT_COLUMNS} FROM shop_products WHERE id=$1`, [id]));
});

shopRouter.put("/admin/shop/products/:id", requirePermission("shop.manage"), async (req, res) => {
  const existing = await queryOne<any>(`SELECT * FROM shop_products WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Product not found" });
  const { categoryId, subcategoryId, name, description, price, oldPrice, stock, active, brand, featured, isNewArrival, bestSeller, lowStockThreshold } = req.body ?? {};
  if (price !== undefined && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
    return sendJson(res, 400, { error: "price must be a non-negative number" });
  }
  if (stock !== undefined && (!Number.isInteger(Number(stock)) || Number(stock) < 0)) {
    return sendJson(res, 400, { error: "stock must be a non-negative whole number" });
  }
  if (oldPrice !== undefined && oldPrice !== null && oldPrice !== "" && (!Number.isFinite(Number(oldPrice)) || Number(oldPrice) < 0)) {
    return sendJson(res, 400, { error: "oldPrice must be a non-negative number" });
  }
  const effectiveCategoryId = categoryId ?? existing.category_id;
  if (categoryId && !(await queryOne(`SELECT id FROM shop_categories WHERE id=$1`, [categoryId]))) {
    return sendJson(res, 404, { error: "Category not found" });
  }
  if (subcategoryId !== undefined && subcategoryId !== null && subcategoryId !== "") {
    const sub = await queryOne<{ category_id: string }>(`SELECT category_id FROM shop_subcategories WHERE id=$1`, [subcategoryId]);
    if (!sub) return sendJson(res, 404, { error: "Subcategory not found" });
    if (sub.category_id !== effectiveCategoryId) return sendJson(res, 400, { error: "Subcategory does not belong to the selected category" });
  }
  await query(
    `UPDATE shop_products SET category_id=$1, subcategory_id=$2, name=$3, description=$4, price=$5, old_price=$6, stock=$7, active=$8, brand=$9, featured=$10, is_new_arrival=$11, best_seller=$12, low_stock_threshold=$13, updated_at=now() WHERE id=$14`,
    [
      effectiveCategoryId,
      subcategoryId === undefined ? existing.subcategory_id : subcategoryId || null,
      name?.trim() || existing.name,
      description !== undefined ? String(description).trim() : existing.description,
      price !== undefined ? Number(price) : existing.price,
      oldPrice !== undefined ? (oldPrice === null || oldPrice === "" ? null : Number(oldPrice)) : existing.old_price,
      stock !== undefined ? Number(stock) : existing.stock,
      typeof active === "boolean" ? active : existing.active,
      brand !== undefined ? String(brand).trim() : existing.brand,
      typeof featured === "boolean" ? featured : existing.featured,
      typeof isNewArrival === "boolean" ? isNewArrival : existing.is_new_arrival,
      typeof bestSeller === "boolean" ? bestSeller : existing.best_seller,
      lowStockThreshold !== undefined && Number.isInteger(Number(lowStockThreshold)) && Number(lowStockThreshold) >= 0
        ? Number(lowStockThreshold)
        : existing.low_stock_threshold,
      req.params.id,
    ]
  );

  // Back-in-stock: this product just went from 0 (or negative -- can't
  // happen, but Number(stock) is user input) to actually available. Every
  // customer who tapped "Notify Me" while it was out gets notified once,
  // then their request is marked notified so restocking again later can
  // notify them again instead of silently no-op'ing on an already-used row.
  const newStock = stock !== undefined ? Number(stock) : existing.stock;
  if (Number(existing.stock) <= 0 && newStock > 0) {
    const subscribers = await query<{ id: string; customer_id: string }>(
      `SELECT id, customer_id FROM shop_stock_notify_requests WHERE product_id=$1 AND notified=false`,
      [req.params.id]
    );
    if (subscribers.length > 0) {
      await query(`UPDATE shop_stock_notify_requests SET notified=true, notified_at=now() WHERE product_id=$1 AND notified=false`, [req.params.id]);
      const productName = name?.trim() || existing.name;
      for (const sub of subscribers) {
        await notifyCustomer(sub.customer_id, "shop_back_in_stock", "Back in Stock", `"${productName}" is back in stock!`);
      }
    }
  }

  sendJson(res, 200, await queryOne(`SELECT ${PRODUCT_COLUMNS} FROM shop_products WHERE id=$1`, [req.params.id]));
});

shopRouter.delete("/admin/shop/products/:id", requirePermission("shop.manage"), async (req, res) => {
  const result = await query(`DELETE FROM shop_products WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Product not found" });
  sendJson(res, 200, { deleted: true });
});

shopRouter.post("/admin/shop/products/:id/images", requirePermission("shop.manage"), async (req, res) => {
  const product = await queryOne(`SELECT id FROM shop_products WHERE id=$1`, [req.params.id]);
  if (!product) return sendJson(res, 404, { error: "Product not found" });
  const parsed = parseDataUri(req.body?.imageBase64);
  if (!parsed) return sendJson(res, 400, { error: "imageBase64 must be a data:<mime>;base64,<data> string" });
  if (!parsed.mimeType.startsWith("image/")) {
    return sendJson(res, 400, { error: "Only image files are allowed — no video" });
  }
  const count = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM shop_product_images WHERE product_id=$1`, [req.params.id]);
  if (Number(count?.n ?? 0) >= MAX_PRODUCT_IMAGES) {
    return sendJson(res, 400, { error: `Maximum ${MAX_PRODUCT_IMAGES} images per product — remove one first` });
  }
  const maxPos = await queryOne<{ m: number }>(`SELECT COALESCE(MAX(position), -1) AS m FROM shop_product_images WHERE product_id=$1`, [req.params.id]);
  const id = randomUUID();
  await query(
    `INSERT INTO shop_product_images (id, product_id, image_data, mime_type, position) VALUES ($1,$2,$3,$4,$5)`,
    [id, req.params.id, parsed.data, parsed.mimeType, (maxPos?.m ?? -1) + 1]
  );
  sendJson(res, 201, { id, position: (maxPos?.m ?? -1) + 1 });
});

shopRouter.delete("/admin/shop/products/:productId/images/:imageId", requirePermission("shop.manage"), async (req, res) => {
  const count = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM shop_product_images WHERE product_id=$1`, [req.params.productId]);
  if (Number(count?.n ?? 0) <= MIN_PRODUCT_IMAGES) {
    return sendJson(res, 400, { error: `Each product needs at least ${MIN_PRODUCT_IMAGES} images — add another before removing this one` });
  }
  const result = await query(`DELETE FROM shop_product_images WHERE id=$1 AND product_id=$2 RETURNING id`, [req.params.imageId, req.params.productId]);
  if (result.length === 0) return sendJson(res, 404, { error: "Image not found" });
  sendJson(res, 200, { deleted: true });
});

// ==================== Admin: Product Variants ====================

shopRouter.get("/admin/shop/products/:productId/variants", requirePermission("shop.manage"), async (req, res) => {
  sendJson(res, 200, await query(`SELECT ${VARIANT_COLUMNS} FROM shop_product_variants WHERE product_id=$1 ORDER BY position`, [req.params.productId]));
});

shopRouter.post("/admin/shop/products/:productId/variants", requirePermission("shop.manage"), async (req, res) => {
  const { label, attributes, price, stock, sku } = req.body ?? {};
  if (!label || !String(label).trim()) return sendJson(res, 400, { error: "label is required" });
  if (!(await queryOne(`SELECT id FROM shop_products WHERE id=$1`, [req.params.productId]))) {
    return sendJson(res, 404, { error: "Product not found" });
  }
  const stockNum = stock == null ? 0 : Number(stock);
  if (!Number.isInteger(stockNum) || stockNum < 0) return sendJson(res, 400, { error: "stock must be a non-negative whole number" });
  if (price !== undefined && price !== null && price !== "" && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
    return sendJson(res, 400, { error: "price must be a non-negative number" });
  }
  const maxPos = await queryOne<{ m: number }>(`SELECT COALESCE(MAX(position), -1) AS m FROM shop_product_variants WHERE product_id=$1`, [req.params.productId]);
  const id = randomUUID();
  await query(
    `INSERT INTO shop_product_variants (id, product_id, label, attributes, price, stock, sku, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      req.params.productId,
      String(label).trim(),
      JSON.stringify(attributes && typeof attributes === "object" ? attributes : {}),
      price !== undefined && price !== null && price !== "" ? Number(price) : null,
      stockNum,
      typeof sku === "string" ? sku.trim() || null : null,
      (maxPos?.m ?? -1) + 1,
    ]
  );
  sendJson(res, 201, await queryOne(`SELECT ${VARIANT_COLUMNS} FROM shop_product_variants WHERE id=$1`, [id]));
});

shopRouter.put("/admin/shop/products/:productId/variants/:id", requirePermission("shop.manage"), async (req, res) => {
  const existing = await queryOne<any>(`SELECT * FROM shop_product_variants WHERE id=$1 AND product_id=$2`, [req.params.id, req.params.productId]);
  if (!existing) return sendJson(res, 404, { error: "Variant not found" });
  const { label, attributes, price, stock, sku, active } = req.body ?? {};
  if (stock !== undefined && (!Number.isInteger(Number(stock)) || Number(stock) < 0)) {
    return sendJson(res, 400, { error: "stock must be a non-negative whole number" });
  }
  if (price !== undefined && price !== null && price !== "" && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
    return sendJson(res, 400, { error: "price must be a non-negative number" });
  }
  await query(
    `UPDATE shop_product_variants SET label=$1, attributes=$2, price=$3, stock=$4, sku=$5, active=$6, updated_at=now() WHERE id=$7`,
    [
      label?.trim() || existing.label,
      attributes && typeof attributes === "object" ? JSON.stringify(attributes) : existing.attributes,
      price !== undefined ? (price === null || price === "" ? null : Number(price)) : existing.price,
      stock !== undefined ? Number(stock) : existing.stock,
      sku !== undefined ? (typeof sku === "string" ? sku.trim() || null : null) : existing.sku,
      typeof active === "boolean" ? active : existing.active,
      req.params.id,
    ]
  );
  sendJson(res, 200, await queryOne(`SELECT ${VARIANT_COLUMNS} FROM shop_product_variants WHERE id=$1`, [req.params.id]));
});

shopRouter.delete("/admin/shop/products/:productId/variants/:id", requirePermission("shop.manage"), async (req, res) => {
  const result = await query(`DELETE FROM shop_product_variants WHERE id=$1 AND product_id=$2 RETURNING id`, [req.params.id, req.params.productId]);
  if (result.length === 0) return sendJson(res, 404, { error: "Variant not found" });
  sendJson(res, 200, { deleted: true });
});

// ==================== Admin: Flash Sales ====================

shopRouter.get("/admin/shop/flash-sales", requirePermission("shop.manage"), async (_req, res) => {
  const sales = await query(`SELECT id, name, starts_at, ends_at, active, created_at FROM shop_flash_sales ORDER BY starts_at DESC`);
  const withItems = await Promise.all(
    (sales as any[]).map(async (s) => ({
      ...s,
      items: await query(
        `SELECT fsi.product_id, fsi.sale_price, p.name AS product_name, p.price AS product_price
         FROM shop_flash_sale_items fsi JOIN shop_products p ON p.id = fsi.product_id WHERE fsi.flash_sale_id=$1`,
        [s.id]
      ),
    }))
  );
  sendJson(res, 200, withItems);
});

shopRouter.post("/admin/shop/flash-sales", requirePermission("shop.manage"), async (req, res) => {
  const { name, startsAt, endsAt, items } = req.body ?? {};
  if (!name || !String(name).trim()) return sendJson(res, 400, { error: "name is required" });
  const starts = new Date(startsAt);
  const ends = new Date(endsAt);
  if (isNaN(starts.getTime()) || isNaN(ends.getTime()) || ends <= starts) {
    return sendJson(res, 400, { error: "startsAt and endsAt must be valid dates, with endsAt after startsAt" });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return sendJson(res, 400, { error: "items (at least one {productId, salePrice}) is required" });
  }
  const id = randomUUID();
  await withTransaction(async (client) => {
    await client.query(`INSERT INTO shop_flash_sales (id, name, starts_at, ends_at) VALUES ($1,$2,$3,$4)`, [id, String(name).trim(), starts, ends]);
    for (const raw of items) {
      const productId = String((raw as any)?.productId ?? "");
      const salePrice = Number((raw as any)?.salePrice);
      if (!productId || !Number.isFinite(salePrice) || salePrice < 0) {
        throw Object.assign(new Error("Each item needs a valid productId and a non-negative salePrice"), { status: 400 });
      }
      await client.query(`INSERT INTO shop_flash_sale_items (flash_sale_id, product_id, sale_price) VALUES ($1,$2,$3)`, [id, productId, salePrice]);
    }
  });
  sendJson(res, 201, { id });
});

shopRouter.put("/admin/shop/flash-sales/:id", requirePermission("shop.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM shop_flash_sales WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Flash sale not found" });
  const { active } = req.body ?? {};
  if (typeof active === "boolean") {
    await query(`UPDATE shop_flash_sales SET active=$1, updated_at=now() WHERE id=$2`, [active, req.params.id]);
  }
  sendJson(res, 200, await queryOne(`SELECT id, name, starts_at, ends_at, active FROM shop_flash_sales WHERE id=$1`, [req.params.id]));
});

shopRouter.delete("/admin/shop/flash-sales/:id", requirePermission("shop.manage"), async (req, res) => {
  const result = await query(`DELETE FROM shop_flash_sales WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Flash sale not found" });
  sendJson(res, 200, { deleted: true });
});

// ==================== Admin: Bundle Deals ====================

shopRouter.get("/admin/shop/bundles", requirePermission("shop.manage"), async (_req, res) => {
  const bundles = await query(`SELECT ${BUNDLE_COLUMNS} FROM shop_bundle_deals ORDER BY created_at DESC`);
  const withItems = await Promise.all((bundles as any[]).map(async (b) => ({ ...b, items: await loadBundleItems(b.id) })));
  sendJson(res, 200, withItems);
});

shopRouter.post("/admin/shop/bundles", requirePermission("shop.manage"), async (req, res) => {
  const { name, description, bundlePrice, items } = req.body ?? {};
  if (!name || !String(name).trim()) return sendJson(res, 400, { error: "name is required" });
  const priceNum = Number(bundlePrice);
  if (!Number.isFinite(priceNum) || priceNum < 0) return sendJson(res, 400, { error: "bundlePrice must be a non-negative number" });
  if (!Array.isArray(items) || items.length === 0) {
    return sendJson(res, 400, { error: "items (at least one {productId, quantity}) is required" });
  }
  const id = randomUUID();
  await withTransaction(async (client) => {
    await client.query(`INSERT INTO shop_bundle_deals (id, name, description, bundle_price) VALUES ($1,$2,$3,$4)`, [
      id,
      String(name).trim(),
      String(description ?? "").trim(),
      priceNum,
    ]);
    for (const raw of items) {
      const productId = String((raw as any)?.productId ?? "");
      const quantity = Number((raw as any)?.quantity ?? 1);
      if (!productId || !Number.isInteger(quantity) || quantity < 1) {
        throw Object.assign(new Error("Each item needs a valid productId and a quantity of at least 1"), { status: 400 });
      }
      await client.query(`INSERT INTO shop_bundle_deal_items (bundle_id, product_id, quantity) VALUES ($1,$2,$3)`, [id, productId, quantity]);
    }
  });
  sendJson(res, 201, { id });
});

shopRouter.put("/admin/shop/bundles/:id", requirePermission("shop.manage"), async (req, res) => {
  const existing = await queryOne<any>(`SELECT * FROM shop_bundle_deals WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Bundle not found" });
  const { name, description, bundlePrice, active } = req.body ?? {};
  if (bundlePrice !== undefined && (!Number.isFinite(Number(bundlePrice)) || Number(bundlePrice) < 0)) {
    return sendJson(res, 400, { error: "bundlePrice must be a non-negative number" });
  }
  await query(
    `UPDATE shop_bundle_deals SET name=$1, description=$2, bundle_price=$3, active=$4, updated_at=now() WHERE id=$5`,
    [
      name?.trim() || existing.name,
      description !== undefined ? String(description).trim() : existing.description,
      bundlePrice !== undefined ? Number(bundlePrice) : existing.bundle_price,
      typeof active === "boolean" ? active : existing.active,
      req.params.id,
    ]
  );
  sendJson(res, 200, await queryOne(`SELECT ${BUNDLE_COLUMNS} FROM shop_bundle_deals WHERE id=$1`, [req.params.id]));
});

shopRouter.delete("/admin/shop/bundles/:id", requirePermission("shop.manage"), async (req, res) => {
  const result = await query(`DELETE FROM shop_bundle_deals WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Bundle not found" });
  sendJson(res, 200, { deleted: true });
});

// ==================== Admin: Delivery Zones ====================

shopRouter.get("/admin/shop/delivery-zones", requirePermission("shop.manage"), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT id, name, fee, active, position FROM shop_delivery_zones ORDER BY position`));
});

shopRouter.post("/admin/shop/delivery-zones", requirePermission("shop.manage"), async (req, res) => {
  const { name, fee } = req.body ?? {};
  if (!name || !String(name).trim()) return sendJson(res, 400, { error: "name is required" });
  const feeNum = Number(fee);
  if (!Number.isFinite(feeNum) || feeNum < 0) return sendJson(res, 400, { error: "fee must be a non-negative number" });
  const maxPos = await queryOne<{ m: number }>(`SELECT COALESCE(MAX(position), -1) AS m FROM shop_delivery_zones`);
  const id = randomUUID();
  try {
    await query(`INSERT INTO shop_delivery_zones (id, name, fee, position) VALUES ($1,$2,$3,$4)`, [id, String(name).trim(), feeNum, (maxPos?.m ?? -1) + 1]);
  } catch (err: any) {
    if (err?.code === "23505") return sendJson(res, 409, { error: "A delivery zone with this name already exists" });
    throw err;
  }
  sendJson(res, 201, await queryOne(`SELECT id, name, fee, active, position FROM shop_delivery_zones WHERE id=$1`, [id]));
});

shopRouter.put("/admin/shop/delivery-zones/:id", requirePermission("shop.manage"), async (req, res) => {
  const existing = await queryOne<any>(`SELECT * FROM shop_delivery_zones WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Delivery zone not found" });
  const { name, fee, active } = req.body ?? {};
  if (fee !== undefined && (!Number.isFinite(Number(fee)) || Number(fee) < 0)) {
    return sendJson(res, 400, { error: "fee must be a non-negative number" });
  }
  await query(`UPDATE shop_delivery_zones SET name=$1, fee=$2, active=$3, updated_at=now() WHERE id=$4`, [
    name?.trim() || existing.name,
    fee !== undefined ? Number(fee) : existing.fee,
    typeof active === "boolean" ? active : existing.active,
    req.params.id,
  ]);
  sendJson(res, 200, await queryOne(`SELECT id, name, fee, active, position FROM shop_delivery_zones WHERE id=$1`, [req.params.id]));
});

shopRouter.delete("/admin/shop/delivery-zones/:id", requirePermission("shop.manage"), async (req, res) => {
  const result = await query(`DELETE FROM shop_delivery_zones WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Delivery zone not found" });
  sendJson(res, 200, { deleted: true });
});

// ==================== Admin: Analytics ====================

// A single summary snapshot -- totals, orders-by-status, a 30-day daily
// revenue series, and the top 10 products by units sold -- rather than a
// generic ad-hoc query endpoint, matching every other admin dashboard
// surface in this codebase (a fixed, predictable response shape).
shopRouter.get("/admin/shop/analytics", requirePermission("shop.manage"), async (_req, res) => {
  const totals = await queryOne<{ order_count: string; revenue: string; avg_order_value: string }>(
    `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_amount), 0) AS revenue, COALESCE(AVG(total_amount), 0) AS avg_order_value
     FROM shop_orders WHERE payment_status='paid'`
  );
  const byStatus = await query(`SELECT status, COUNT(*) AS count FROM shop_orders GROUP BY status`);
  const dailyRevenue = await query(
    `SELECT date_trunc('day', created_at)::date AS day, COALESCE(SUM(total_amount), 0) AS revenue, COUNT(*) AS order_count
     FROM shop_orders WHERE payment_status='paid' AND created_at >= now() - interval '30 days'
     GROUP BY day ORDER BY day ASC`
  );
  const topProducts = await query(
    `SELECT id, name, sold_count, price FROM shop_products ORDER BY sold_count DESC LIMIT 10`
  );
  sendJson(res, 200, {
    orderCount: Number(totals?.order_count ?? 0),
    revenue: Number(totals?.revenue ?? 0),
    avgOrderValue: Number(totals?.avg_order_value ?? 0),
    ordersByStatus: byStatus,
    dailyRevenue,
    topProducts,
  });
});

// ==================== Admin: Payment collection methods ====================

shopRouter.get("/admin/shop/payment-methods", requirePermission("shop.manage"), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM shop_payment_methods ORDER BY method`));
});

const SHOP_PAYMENT_METHOD_RE = /^(evc|edahab)$/;
const PAYMENT_NUMBER_RE = /^\d{6,15}$/;

shopRouter.put("/admin/shop/payment-methods/:method", requirePermission("shop.manage"), async (req, res) => {
  const method = req.params.method;
  if (!SHOP_PAYMENT_METHOD_RE.test(method)) return sendJson(res, 400, { error: "Unknown payment method" });
  const paymentNumber = String(req.body?.paymentNumber ?? "").trim();
  const ussdTemplate = String(req.body?.ussdTemplate ?? "").trim();
  const label = String(req.body?.label ?? "").trim();
  if (!paymentNumber || !PAYMENT_NUMBER_RE.test(paymentNumber)) return sendJson(res, 400, { error: "paymentNumber must be 6-15 digits" });
  if (!ussdTemplate.includes("{amount}")) return sendJson(res, 400, { error: "ussdTemplate must include {amount}" });
  if (!label) return sendJson(res, 400, { error: "label is required" });
  const rows = await query(
    `UPDATE shop_payment_methods SET label=$1, payment_number=$2, ussd_template=$3, updated_at=now(), updated_by=$4 WHERE method=$5 RETURNING method`,
    [label, paymentNumber, ussdTemplate, req.auth!.sub, method]
  );
  if (rows.length === 0) return sendJson(res, 404, { error: "Unknown payment method" });
  sendJson(res, 200, await queryOne(`SELECT * FROM shop_payment_methods WHERE method=$1`, [method]));
});

// ==================== Admin: Orders ====================

const SHOP_ORDER_LIST_SELECT = `
  SELECT so.*, c.name AS customer_name, c.phone AS customer_phone
  FROM shop_orders so
  LEFT JOIN customers c ON c.id = so.customer_id
`;
const SHOP_ORDER_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled", "failed", "returned", "refunded"];
// No further status change is ever valid once an order reaches one of
// these -- each is a true end state for this simplified status model
// (a full Returns/Exchanges/Refunds *request* workflow with its own
// approval stages is a separate, later feature; these three are just the
// order's own resting states once that process, or a failed/cancelled
// purchase, concludes).
const TERMINAL_SHOP_STATUSES = ["delivered", "cancelled", "failed", "returned", "refunded"];
// The physical product comes back into inventory for all three of these --
// cancelled/failed because the order never completed, returned because the
// customer sent it back. Refunded alone doesn't imply that (it's a payment
// outcome, usually applied on top of an already-returned order), so it's
// deliberately left out here.
const STOCK_RESTORING_STATUSES = ["cancelled", "failed", "returned"];

shopRouter.get("/admin/shop/orders", requirePermission("shop.manage"), async (req, res) => {
  const { status, search } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `${SHOP_ORDER_LIST_SELECT} WHERE 1=1`;
  if (status && SHOP_ORDER_STATUSES.includes(status)) {
    args.push(status);
    sql += ` AND so.status=$${args.length}`;
  }
  if (search) {
    args.push(`%${search}%`);
    sql += ` AND (so.id ILIKE $${args.length} OR c.name ILIKE $${args.length} OR c.phone ILIKE $${args.length} OR so.delivery_phone ILIKE $${args.length})`;
  }
  sql += ` ORDER BY so.created_at DESC LIMIT 200`;
  sendJson(res, 200, await query(sql, args));
});

shopRouter.get("/admin/shop/orders/:id", requirePermission("shop.manage"), async (req, res) => {
  const order = await queryOne(`${SHOP_ORDER_LIST_SELECT} WHERE so.id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, { ...order, items: await loadOrderItems(req.params.id) });
});

// ==================== Agent: Orders (read + Complete Order) ====================

// The Agent App's own Orders tab -- shows real Shop order data straight
// from this same shop_orders table, same SHOP_ORDER_LIST_SELECT/filters
// as the Admin Dashboard's identical routes above, just under agent auth
// instead of the "shop.manage" staff permission. Shop's multi-stage
// courier/tracking lifecycle (processing/shipped/returned/refunded) stays
// admin-only via the existing PUT .../status route below -- an agent can
// only ever move a paid order straight to 'delivered' via the Complete
// Order action further down, mirroring VIP Numbers' identical
// POST .../complete (vipNumbers.routes.ts).
shopRouter.get("/agent/shop/orders", requireAuth("agent"), async (req, res) => {
  const { status, search } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `${SHOP_ORDER_LIST_SELECT} WHERE 1=1`;
  if (status && SHOP_ORDER_STATUSES.includes(status)) {
    args.push(status);
    sql += ` AND so.status=$${args.length}`;
  }
  if (search) {
    args.push(`%${search}%`);
    sql += ` AND (so.id ILIKE $${args.length} OR c.name ILIKE $${args.length} OR c.phone ILIKE $${args.length} OR so.delivery_phone ILIKE $${args.length})`;
  }
  sql += ` ORDER BY so.created_at DESC LIMIT 200`;
  sendJson(res, 200, await query(sql, args));
});

shopRouter.get("/agent/shop/orders/:id", requireAuth("agent"), async (req, res) => {
  const order = await queryOne(`${SHOP_ORDER_LIST_SELECT} WHERE so.id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, { ...order, items: await loadOrderItems(req.params.id) });
});

// The Agent App's "Complete Order" action -- same locking/guards as VIP
// Numbers' identical POST /agent/vip-numbers/orders/:id/complete
// (payment must already be confirmed, order must not already be
// terminal), hardcoded to 'delivered' rather than accepting an arbitrary
// status: an agent can only ever complete a paid order here, never
// cancel/ship/return one (those stay admin-only via the existing PUT
// .../status route above). Never touches payment_status/paid_at -- the
// order is already 'paid' by the time an agent can see it at all (see
// the read-only GET routes' own comment), and this action has nothing to
// do with payment. delivered_at/status=delivered is exactly what the
// admin route's own "delivered" branch already sets, so the Admin
// Dashboard and Customer App see the identical terminal state regardless
// of whether an admin or an agent was the one who completed it.
// recordActivity's adminId is left undefined -- admin_activity_log.admin_id
// is FK'd to admin_users, not agents, so an agent's own id would violate
// that constraint (same reasoning vipNumbers.routes.ts's identical action
// already follows).
shopRouter.post("/agent/shop/orders/:id/complete", requireAuth("agent"), async (req, res) => {
  let existing: { status: string; customer_id: string };
  try {
    existing = await withTransaction(async (client) => {
      const row = await client.query(
        `SELECT status, payment_status, customer_id FROM shop_orders WHERE id=$1 FOR UPDATE`,
        [req.params.id]
      );
      const order = row.rows[0];
      if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
      if (TERMINAL_SHOP_STATUSES.includes(order.status)) {
        throw Object.assign(new Error(`This order is already ${order.status} and cannot be changed further`), { status: 409 });
      }
      if (order.payment_status !== "paid") {
        throw Object.assign(new Error("This order cannot be completed until payment is confirmed"), { status: 409 });
      }
      await client.query(
        `UPDATE shop_orders SET status='delivered', delivered_at=now(), updated_at=now() WHERE id=$1`,
        [req.params.id]
      );
      return order;
    });
  } catch (err: any) {
    if (err?.status) return sendJson(res, err.status, { error: err.message });
    throw err;
  }
  await query(`INSERT INTO shop_order_status_history (order_id, status, note) VALUES ($1,'delivered','Completed by agent')`, [
    req.params.id,
  ]);
  await recordActivity({
    adminId: undefined,
    action: "shop_order_completed_by_agent",
    entityType: "shop_order",
    entityId: req.params.id,
    oldValue: { status: existing.status },
    newValue: { status: "delivered" },
  });
  await notifyCustomer(
    existing.customer_id,
    "shop_order_update",
    "Order Delivered",
    `Order ${req.params.id} has been delivered. Thank you for shopping with DALAB!`
  );
  sendJson(res, 200, await queryOne(`${SHOP_ORDER_LIST_SELECT} WHERE so.id=$1`, [req.params.id]));
});

// Manual payment confirmation — mirrors Money Exchange's manual-verify path
// rather than the automatic SMS-matching pipeline (see migration 074's
// header comment for why). An Admin sees the collection number receive the
// money (bank/SMS/wallet app, whatever they already check today) and taps
// this once confirmed.
shopRouter.put("/admin/shop/orders/:id/payment-status", requirePermission("shop.manage"), async (req, res) => {
  const existing = await queryOne<{ status: string; payment_status: string; customer_id: string }>(
    `SELECT status, payment_status, customer_id FROM shop_orders WHERE id=$1`,
    [req.params.id]
  );
  if (!existing) return sendJson(res, 404, { error: "Order not found" });
  if (existing.payment_status === "paid") return sendJson(res, 409, { error: "This order is already marked paid" });
  if (TERMINAL_SHOP_STATUSES.includes(existing.status)) {
    return sendJson(res, 409, { error: `This order is already ${existing.status} and can no longer be marked paid` });
  }

  await query(
    `UPDATE shop_orders SET payment_status='paid', paid_at=now(),
       status = CASE WHEN status='pending' THEN 'processing' ELSE status END,
       verified_by_admin_id=$1, updated_at=now() WHERE id=$2`,
    [req.auth!.sub, req.params.id]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "shop_order_payment_confirmed",
    entityType: "shop_order",
    entityId: req.params.id,
    oldValue: { paymentStatus: existing.payment_status },
    newValue: { paymentStatus: "paid" },
  });
  if (existing.status === "pending") {
    await query(`INSERT INTO shop_order_status_history (order_id, status, note) VALUES ($1,'processing','Payment confirmed')`, [req.params.id]);
  }
  await notifyCustomer(existing.customer_id, "shop_order_update", "Order Confirmed", `Your payment for order ${req.params.id} has been confirmed. We're preparing it now.`);
  // Broadcast to every agent device -- Shop orders carry no assigned-agent
  // column (customer-initiated checkout, not agent-created), so any agent
  // may need to know a new paid order exists. Real, push-only signal (see
  // sendPushToAllAgents's own comment); never fabricated/local-only.
  await sendPushToAllAgents({
    title: "🛒 Shop Order Paid",
    body: `Order ${req.params.id} payment confirmed.`,
    data: { screen: "agent_orders", orderType: "shop", orderId: req.params.id },
  });
  sendJson(res, 200, await queryOne(`${SHOP_ORDER_LIST_SELECT} WHERE so.id=$1`, [req.params.id]));
});

const STATUS_NOTIFICATIONS: Record<string, { title: string; body: (id: string) => string }> = {
  processing: { title: "Order Processing", body: (id) => `Order ${id} is being prepared.` },
  shipped: { title: "Order Shipped", body: (id) => `Order ${id} is on its way.` },
  delivered: { title: "Order Delivered", body: (id) => `Order ${id} has been delivered. Thank you for shopping with DALAB!` },
  cancelled: { title: "Order Cancelled", body: (id) => `Order ${id} has been cancelled.` },
  failed: { title: "Order Failed", body: (id) => `Order ${id} could not be completed.` },
  returned: { title: "Order Returned", body: (id) => `Order ${id} has been marked as returned.` },
  refunded: { title: "Order Refunded", body: (id) => `Order ${id} has been refunded.` },
};

// Staged delivery tracking: pending -> processing -> shipped -> delivered,
// or one of the terminal outcomes (cancelled/failed/returned/refunded) from
// any non-terminal state. trackingReference/trackingNote/courierName are
// optional free text an Admin can attach at any stage for the customer to
// see — no courier/GPS integration, same manual-staged-update simplicity as
// the rest of this admin dashboard.
shopRouter.put("/admin/shop/orders/:id/status", requirePermission("shop.manage"), async (req, res) => {
  const { status, trackingReference, trackingNote, courierName } = req.body ?? {};
  if (!SHOP_ORDER_STATUSES.includes(status)) return sendJson(res, 400, { error: `status must be one of ${SHOP_ORDER_STATUSES.join(", ")}` });
  const existing = await queryOne<{ status: string; customer_id: string }>(`SELECT status, customer_id FROM shop_orders WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Order not found" });
  if (TERMINAL_SHOP_STATUSES.includes(existing.status)) {
    return sendJson(res, 409, { error: `This order is already ${existing.status} and cannot be changed further` });
  }

  // Reverses the stock reservation made at order-creation time — same
  // "reverse the reservation, never mutate history" principle
  // reseller_withdrawals uses, applied here by simply crediting the stock
  // back rather than a second ledger row (Shop has no wallet ledger).
  // Safe against double-restoration: existing.status is guaranteed
  // non-terminal at this point (checked above), so this can only ever fire
  // once per order.
  if (STOCK_RESTORING_STATUSES.includes(status)) {
    await restoreShopOrderStock(req.params.id);
  }

  await query(
    `UPDATE shop_orders SET status=$1,
       tracking_reference=COALESCE($2, tracking_reference),
       tracking_note=COALESCE($3, tracking_note),
       courier_name=COALESCE($4, courier_name),
       delivered_at = CASE WHEN $1='delivered' THEN now() ELSE delivered_at END,
       cancelled_at = CASE WHEN $1='cancelled' THEN now() ELSE cancelled_at END,
       updated_at=now()
     WHERE id=$5`,
    [
      status,
      typeof trackingReference === "string" ? trackingReference.trim() : null,
      typeof trackingNote === "string" ? trackingNote.trim() : null,
      typeof courierName === "string" ? courierName.trim() : null,
      req.params.id,
    ]
  );
  await query(
    `INSERT INTO shop_order_status_history (order_id, status, note) VALUES ($1,$2,$3)`,
    [req.params.id, status, typeof trackingNote === "string" ? trackingNote.trim() || null : null]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "shop_order_status_updated",
    entityType: "shop_order",
    entityId: req.params.id,
    oldValue: { status: existing.status },
    newValue: { status, trackingReference: trackingReference ?? null, trackingNote: trackingNote ?? null, courierName: courierName ?? null },
  });
  const notification = STATUS_NOTIFICATIONS[status];
  if (notification) await notifyCustomer(existing.customer_id, "shop_order_update", notification.title, notification.body(req.params.id));
  sendJson(res, 200, await queryOne(`${SHOP_ORDER_LIST_SELECT} WHERE so.id=$1`, [req.params.id]));
});

// ==================== Admin: Reviews ====================

shopRouter.get("/admin/shop/reviews", requirePermission("shop.manage"), async (req, res) => {
  const { productId } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `
    SELECT r.id, r.product_id, p.name AS product_name, r.customer_id, c.name AS customer_name,
           r.rating, r.review_text, (r.photo_data IS NOT NULL) AS has_photo, r.created_at
    FROM shop_reviews r
    JOIN shop_products p ON p.id = r.product_id
    JOIN customers c ON c.id = r.customer_id
    WHERE 1=1`;
  if (productId) { args.push(productId); sql += ` AND r.product_id=$${args.length}`; }
  sql += ` ORDER BY r.created_at DESC LIMIT 200`;
  sendJson(res, 200, await query(sql, args));
});

// Moderation only -- deleting an inappropriate review. No edit route: a
// review is the customer's own record of their purchase experience, not
// something Admin should be able to silently rewrite.
shopRouter.delete("/admin/shop/reviews/:id", requirePermission("shop.manage"), async (req, res) => {
  const result = await query(`DELETE FROM shop_reviews WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Review not found" });
  await recordActivity({
    adminId: req.auth!.sub,
    action: "shop_review_deleted",
    entityType: "shop_review",
    entityId: req.params.id,
    oldValue: null,
    newValue: { deleted: true },
  });
  sendJson(res, 200, { deleted: true });
});

// ==================== Admin: Returns / Exchange / Refund ====================

shopRouter.get("/admin/shop/returns", requirePermission("shop.manage"), async (req, res) => {
  const { status } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `
    SELECT r.*, c.name AS customer_name, c.phone AS customer_phone
    FROM shop_return_requests r JOIN customers c ON c.id = r.customer_id
    WHERE 1=1`;
  if (status && RETURN_STATUSES.includes(status)) {
    args.push(status);
    sql += ` AND r.status=$${args.length}`;
  }
  sql += ` ORDER BY r.created_at DESC LIMIT 200`;
  sendJson(res, 200, await query(sql, args));
});

shopRouter.get("/admin/shop/returns/:id", requirePermission("shop.manage"), async (req, res) => {
  const row = await queryOne(
    `SELECT r.*, c.name AS customer_name, c.phone AS customer_phone FROM shop_return_requests r JOIN customers c ON c.id = r.customer_id WHERE r.id=$1`,
    [req.params.id]
  );
  if (!row) return sendJson(res, 404, { error: "Request not found" });
  sendJson(res, 200, row);
});

const RETURN_STATUS_NOTIFICATIONS: Record<string, { title: string; body: (type: string) => string }> = {
  approved: { title: "Request Approved", body: (t) => `Your ${t} request has been approved.` },
  rejected: { title: "Request Rejected", body: (t) => `Your ${t} request was not approved.` },
  processing: { title: "Request Processing", body: (t) => `Your ${t} request is being processed.` },
  completed: { title: "Request Completed", body: (t) => `Your ${t} request has been completed.` },
};

shopRouter.put("/admin/shop/returns/:id/status", requirePermission("shop.manage"), async (req, res) => {
  const { status, adminNote } = req.body ?? {};
  if (!RETURN_STATUSES.includes(status)) return sendJson(res, 400, { error: `status must be one of ${RETURN_STATUSES.join(", ")}` });
  const existing = await queryOne<{ status: string; customer_id: string; type: string }>(
    `SELECT status, customer_id, type FROM shop_return_requests WHERE id=$1`,
    [req.params.id]
  );
  if (!existing) return sendJson(res, 404, { error: "Request not found" });
  if (RETURN_TERMINAL.includes(existing.status)) {
    return sendJson(res, 409, { error: `This request is already ${existing.status} and cannot be changed further` });
  }
  if (!RETURN_TRANSITIONS[existing.status]?.includes(status)) {
    return sendJson(res, 409, { error: `Cannot move from ${existing.status} to ${status}` });
  }
  await query(
    `UPDATE shop_return_requests SET status=$1, admin_note=COALESCE($2, admin_note), updated_at=now() WHERE id=$3`,
    [status, typeof adminNote === "string" ? adminNote.trim() : null, req.params.id]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "shop_return_status_updated",
    entityType: "shop_return_request",
    entityId: req.params.id,
    oldValue: { status: existing.status },
    newValue: { status, adminNote: adminNote ?? null },
  });
  const notification = RETURN_STATUS_NOTIFICATIONS[status];
  if (notification) await notifyCustomer(existing.customer_id, "shop_return_update", notification.title, notification.body(existing.type));
  sendJson(res, 200, await queryOne(`SELECT * FROM shop_return_requests WHERE id=$1`, [req.params.id]));
});
