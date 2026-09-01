import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { parseDataUri } from "../utils/dataUri.js";
import { createPaymentTransaction } from "../utils/paymentTransactions.js";
import { notifyCustomer } from "../services/customerNotify.js";
import { formatUssdAmount } from "../utils/ussdFormatting.js";

export const shopRouter = Router();

function shopOrderRef(): string {
  return "DSH" + Math.floor(100000000 + Math.random() * 900000000);
}

// Africa/Mogadishu is a fixed UTC+3 offset with no DST -- same assumption
// public_settings-driven screens elsewhere in this app already make, so a
// dedicated timezone library isn't warranted for one schedule check.
function nowInMogadishu(): { dayOfWeek: number; minutesSinceMidnight: number } {
  const utc = Date.now();
  const local = new Date(utc + 3 * 60 * 60 * 1000);
  return {
    dayOfWeek: local.getUTCDay(),
    minutesSinceMidnight: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

async function loadShopSettings() {
  return queryOne<{
    working_days: number[];
    opening_time: string;
    closing_time: string;
    manual_override: string | null;
    updated_at: string;
  }>(`SELECT working_days, opening_time, closing_time, manual_override, updated_at FROM shop_settings WHERE id=1`);
}

function computeIsOpen(settings: {
  working_days: number[];
  opening_time: string;
  closing_time: string;
  manual_override: string | null;
}): boolean {
  if (settings.manual_override === "open") return true;
  if (settings.manual_override === "closed") return false;
  const { dayOfWeek, minutesSinceMidnight } = nowInMogadishu();
  if (!settings.working_days.includes(dayOfWeek)) return false;
  const open = timeToMinutes(settings.opening_time);
  const close = timeToMinutes(settings.closing_time);
  return minutesSinceMidnight >= open && minutesSinceMidnight < close;
}

// ---------------- Browse (public) ----------------

shopRouter.get("/shop/categories", async (_req, res) => {
  sendJson(
    res,
    200,
    await query(`SELECT id, name, emoji, position FROM shop_categories WHERE active=true ORDER BY position`)
  );
});

shopRouter.get("/shop/electronics-subcategories", async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT id, name, position FROM shop_electronics_subcategories WHERE active=true ORDER BY position, name`
    )
  );
});

shopRouter.get("/shop/brands", async (_req, res) => {
  sendJson(res, 200, await query(`SELECT id, name FROM shop_brands WHERE active=true ORDER BY name`));
});

// Every product row's effective/sale price and image list are computed
// here once and reused by both the list and detail routes below, so
// "what a customer is actually charged" can never drift between the two.
const PRODUCT_SELECT = `
  SELECT
    p.id, p.category_id, p.subcategory_id, p.brand_id, p.name, p.description,
    p.price, p.discount_price, p.stock, p.sizes, p.colors,
    p.is_featured, p.is_new_arrival, p.is_best_seller, p.created_at,
    COALESCE(fs.discount_price, p.discount_price) AS effective_price,
    fs.ends_at AS flash_sale_ends_at,
    b.name AS brand_name,
    COALESCE(r.avg_rating, 0) AS avg_rating,
    COALESCE(r.review_count, 0) AS review_count,
    COALESCE(sold.qty, 0) AS popularity,
    COALESCE(imgs.images, '[]') AS images
  FROM shop_products p
  LEFT JOIN shop_brands b ON b.id = p.brand_id
  LEFT JOIN LATERAL (
    SELECT discount_price, ends_at FROM shop_flash_sales
    WHERE product_id = p.id AND active = true AND now() BETWEEN starts_at AND ends_at
    ORDER BY discount_price ASC LIMIT 1
  ) fs ON true
  LEFT JOIN LATERAL (
    SELECT ROUND(AVG(rating)::numeric, 1) AS avg_rating, COUNT(*) AS review_count
    FROM shop_reviews WHERE product_id = p.id
  ) r ON true
  LEFT JOIN LATERAL (
    SELECT SUM(quantity) AS qty FROM shop_order_items oi
    JOIN shop_orders o ON o.id = oi.order_id
    WHERE oi.product_id = p.id AND o.status <> 'cancelled' AND o.status <> 'failed'
  ) sold ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('id', id, 'position', position) ORDER BY position) AS images
    FROM shop_product_images WHERE product_id = p.id
  ) imgs ON true
`;

shopRouter.get("/shop/products", async (req, res) => {
  const where: string[] = ["p.active = true"];
  const params: unknown[] = [];

  if (req.query.categoryId) {
    params.push(String(req.query.categoryId));
    where.push(`p.category_id = $${params.length}`);
  }
  if (req.query.subcategoryId) {
    params.push(String(req.query.subcategoryId));
    where.push(`p.subcategory_id = $${params.length}`);
  }
  if (req.query.brandId) {
    params.push(String(req.query.brandId));
    where.push(`p.brand_id = $${params.length}`);
  }
  if (req.query.search) {
    params.push(`%${String(req.query.search)}%`);
    where.push(`p.name ILIKE $${params.length}`);
  }
  if (req.query.minPrice) {
    params.push(Number(req.query.minPrice));
    where.push(`p.price >= $${params.length}`);
  }
  if (req.query.maxPrice) {
    params.push(Number(req.query.maxPrice));
    where.push(`p.price <= $${params.length}`);
  }
  if (req.query.featured === "true") where.push(`p.is_featured = true`);
  if (req.query.newArrival === "true") where.push(`p.is_new_arrival = true`);
  if (req.query.bestSeller === "true") where.push(`p.is_best_seller = true`);
  if (req.query.onSale === "true") {
    where.push(`(p.discount_price IS NOT NULL OR EXISTS (
      SELECT 1 FROM shop_flash_sales fs WHERE fs.product_id = p.id AND fs.active = true AND now() BETWEEN fs.starts_at AND fs.ends_at
    ))`);
  }

  const sortMap: Record<string, string> = {
    newest: "p.created_at DESC",
    price_asc: "COALESCE(fs.discount_price, p.discount_price, p.price) ASC",
    price_desc: "COALESCE(fs.discount_price, p.discount_price, p.price) DESC",
    popularity: "popularity DESC",
  };
  const sort = sortMap[String(req.query.sort ?? "newest")] ?? sortMap.newest;

  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  params.push(limit, offset);

  const sql = `${PRODUCT_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${sort} LIMIT $${params.length - 1} OFFSET $${params.length}`;
  sendJson(res, 200, await query(sql, params));
});

shopRouter.get("/shop/products/:id", async (req, res) => {
  const product = await queryOne(`${PRODUCT_SELECT} WHERE p.id = $1 AND p.active = true`, [req.params.id]);
  if (!product) return sendJson(res, 404, { error: "Product not found" });
  sendJson(res, 200, product);
});

// Public, unguessable UUID -- same reasoning as promo_images' image route.
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

shopRouter.get("/shop/products/:id/reviews", async (req, res) => {
  const rows = await query(
    `SELECT id, customer_id, rating, review_text, (photo_data IS NOT NULL) AS has_photo, created_at
     FROM shop_reviews WHERE product_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [req.params.id]
  );
  sendJson(res, 200, rows);
});

shopRouter.get("/shop/reviews/:id/photo", async (req, res) => {
  const row = await queryOne<{ photo_data: Buffer | null; photo_mime: string | null }>(
    `SELECT photo_data, photo_mime FROM shop_reviews WHERE id=$1`,
    [req.params.id]
  );
  if (!row?.photo_data) return sendJson(res, 404, { error: "No photo for this review" });
  res.setHeader("Content-Type", row.photo_mime ?? "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(row.photo_data);
});

shopRouter.get("/shop/payment-methods", async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT id, method, label, payment_number FROM shop_payment_methods WHERE enabled=true ORDER BY sort_order, label`
    )
  );
});

shopRouter.get("/shop/settings", async (_req, res) => {
  const settings = await loadShopSettings();
  if (!settings) return sendJson(res, 500, { error: "Shop settings missing" });
  sendJson(res, 200, {
    isOpen: computeIsOpen(settings),
    workingDays: settings.working_days,
    openingTime: settings.opening_time,
    closingTime: settings.closing_time,
    manualOverride: settings.manual_override,
  });
});

shopRouter.get("/shop/promo-codes/:code/validate", async (req, res) => {
  const subtotal = Number(req.query.subtotal ?? 0);
  const promo = await queryOne<{
    id: string;
    discount_type: "percent" | "fixed";
    discount_value: string;
    min_order_amount: string;
    usage_limit: number | null;
    used_count: number;
    active: boolean;
    starts_at: string | null;
    ends_at: string | null;
  }>(`SELECT * FROM shop_promo_codes WHERE code=$1`, [String(req.params.code).toUpperCase()]);

  if (!promo || !promo.active) return sendJson(res, 404, { error: "Promo code not found or inactive" });
  const now = Date.now();
  if (promo.starts_at && new Date(promo.starts_at).getTime() > now)
    return sendJson(res, 400, { error: "This promo code is not active yet" });
  if (promo.ends_at && new Date(promo.ends_at).getTime() < now)
    return sendJson(res, 400, { error: "This promo code has expired" });
  if (promo.usage_limit != null && promo.used_count >= promo.usage_limit)
    return sendJson(res, 400, { error: "This promo code has reached its usage limit" });
  if (subtotal < Number(promo.min_order_amount))
    return sendJson(res, 400, { error: `Minimum order of $${promo.min_order_amount} required for this code` });

  const discountAmount =
    promo.discount_type === "percent"
      ? Math.round(((subtotal * Number(promo.discount_value)) / 100) * 100) / 100
      : Math.min(Number(promo.discount_value), subtotal);

  sendJson(res, 200, { code: req.params.code.toUpperCase(), discountAmount });
});

// ---------------- Orders (customer) ----------------

const ORDER_SELECT = `
  SELECT o.*
  FROM shop_orders o
`;

async function loadOrderWithItems(id: string) {
  const order = await queryOne<Record<string, unknown>>(`${ORDER_SELECT} WHERE o.id=$1`, [id]);
  if (!order) return null;
  const items = await query(
    `SELECT id, product_id, product_name, unit_price, quantity, subtotal, size, color FROM shop_order_items WHERE order_id=$1`,
    [id]
  );
  return { ...order, items };
}

shopRouter.post("/shop/orders", requireAuth("customer"), async (req, res) => {
  const body = req.body ?? {};
  const items: { productId: string; quantity: number; size?: string; color?: string }[] = Array.isArray(body.items)
    ? body.items
    : [];
  const senderPhone = String(body.senderPhone ?? "").trim();
  const deliveryName = String(body.deliveryName ?? "").trim();
  const deliveryPhone = String(body.deliveryPhone ?? "").trim();
  const deliveryAddress = String(body.deliveryAddress ?? "").trim();
  const paymentMethod = body.paymentMethod ? String(body.paymentMethod) : null;
  const clientRequestId = body.clientRequestId ? String(body.clientRequestId) : null;
  const promoCode = body.promoCode ? String(body.promoCode).toUpperCase() : null;
  const isGift = body.isGift === true;

  if (items.length === 0) return sendJson(res, 400, { error: "Cart is empty" });
  if (!senderPhone || !deliveryName || !deliveryPhone || !deliveryAddress) {
    return sendJson(res, 400, { error: "senderPhone, deliveryName, deliveryPhone, and deliveryAddress are required" });
  }
  if (isGift && (!body.giftRecipientName || !body.giftRecipientPhone)) {
    return sendJson(res, 400, { error: "giftRecipientName and giftRecipientPhone are required for a gift order" });
  }

  const settings = await loadShopSettings();
  if (settings && !computeIsOpen(settings)) {
    return sendJson(res, 400, { error: "Shop is currently closed — you can browse, but not place new orders" });
  }

  if (clientRequestId) {
    const existing = await queryOne<{ id: string }>(`SELECT id FROM shop_orders WHERE client_request_id=$1`, [
      clientRequestId,
    ]);
    if (existing) return sendJson(res, 200, await loadOrderWithItems(existing.id));
  }

  try {
    const orderId = await withTransaction(async (client) => {
      let subtotal = 0;
      const lineItems: {
        productId: string;
        productName: string;
        unitPrice: number;
        quantity: number;
        lineSubtotal: number;
        size?: string;
        color?: string;
      }[] = [];

      for (const item of items) {
        const qty = Number(item.quantity);
        if (!item.productId || !Number.isInteger(qty) || qty <= 0) {
          throw Object.assign(new Error("Each item needs a productId and a positive integer quantity"), { statusCode: 400 });
        }
        // FOR UPDATE: locks this product row for the rest of the
        // transaction so two concurrent checkouts can never both oversell
        // the same last unit of stock.
        const product = await client.query(
          `SELECT id, name, price, discount_price, stock, active,
                  (SELECT discount_price FROM shop_flash_sales fs WHERE fs.product_id = shop_products.id AND fs.active = true AND now() BETWEEN fs.starts_at AND fs.ends_at ORDER BY discount_price ASC LIMIT 1) AS flash_price
           FROM shop_products WHERE id=$1 FOR UPDATE`,
          [item.productId]
        );
        const row = product.rows[0];
        if (!row || !row.active) {
          throw Object.assign(new Error(`Product ${item.productId} is no longer available`), { statusCode: 400 });
        }
        if (row.stock < qty) {
          throw Object.assign(new Error(`Only ${row.stock} left in stock for ${row.name}`), { statusCode: 409 });
        }
        const unitPrice = Number(row.flash_price ?? row.discount_price ?? row.price);
        const lineSubtotal = Math.round(unitPrice * qty * 100) / 100;
        subtotal += lineSubtotal;
        lineItems.push({
          productId: row.id,
          productName: row.name,
          unitPrice,
          quantity: qty,
          lineSubtotal,
          size: item.size,
          color: item.color,
        });
        await client.query(`UPDATE shop_products SET stock = stock - $1, updated_at = now() WHERE id=$2`, [
          qty,
          row.id,
        ]);
      }

      let discountAmount = 0;
      if (promoCode) {
        const promo = await client.query(
          `SELECT * FROM shop_promo_codes WHERE code=$1 AND active=true
             AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at >= now())
             AND (usage_limit IS NULL OR used_count < usage_limit)
             AND min_order_amount <= $2 FOR UPDATE`,
          [promoCode, subtotal]
        );
        const promoRow = promo.rows[0];
        if (!promoRow) {
          throw Object.assign(new Error("Promo code is invalid, expired, or doesn't apply to this order"), {
            statusCode: 400,
          });
        }
        discountAmount =
          promoRow.discount_type === "percent"
            ? Math.round(((subtotal * Number(promoRow.discount_value)) / 100) * 100) / 100
            : Math.min(Number(promoRow.discount_value), subtotal);
        await client.query(`UPDATE shop_promo_codes SET used_count = used_count + 1 WHERE id=$1`, [promoRow.id]);
      }

      const deliveryFee = 0; // Flat free delivery for now -- no zone/distance pricing model exists yet.
      const totalAmount = Math.max(0, Math.round((subtotal - discountAmount + deliveryFee) * 100) / 100);

      const id = shopOrderRef();
      await client.query(
        `INSERT INTO shop_orders (
           id, customer_id, sender_phone, delivery_name, delivery_phone, delivery_address, delivery_notes,
           promo_code, discount_amount, delivery_fee, total_amount, payment_method,
           is_gift, gift_recipient_name, gift_recipient_phone, gift_message, gift_wrap, client_request_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          id,
          req.auth!.sub,
          senderPhone,
          deliveryName,
          deliveryPhone,
          deliveryAddress,
          body.deliveryNotes ? String(body.deliveryNotes) : null,
          promoCode,
          discountAmount,
          deliveryFee,
          totalAmount,
          paymentMethod,
          isGift,
          isGift ? String(body.giftRecipientName) : null,
          isGift ? String(body.giftRecipientPhone) : null,
          isGift && body.giftMessage ? String(body.giftMessage) : null,
          isGift && body.giftWrap === true,
          clientRequestId,
        ]
      );
      for (const li of lineItems) {
        await client.query(
          `INSERT INTO shop_order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal, size, color)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [randomUUID(), id, li.productId, li.productName, li.unitPrice, li.quantity, li.lineSubtotal, li.size ?? null, li.color ?? null]
        );
      }
      return id;
    });

    const order = await loadOrderWithItems(orderId);

    let dialUssd: string | undefined;
    if (paymentMethod) {
      const method = await queryOne<{ ussd_template: string | null }>(
        `SELECT ussd_template FROM shop_payment_methods WHERE method=$1 AND enabled=true`,
        [paymentMethod]
      );
      if (method?.ussd_template) {
        dialUssd = method.ussd_template.replace("{amount}", formatUssdAmount((order as any).total_amount));
      }
    }

    await createPaymentTransaction({
      smsLogId: null,
      orderId,
      transactionRef: null,
      customerPhone: senderPhone,
      amount: (order as any)?.total_amount ?? null,
      paymentTimestamp: new Date().toISOString(),
      status: "pending",
    });

    await notifyCustomer(
      req.auth!.sub,
      "shop_order_placed",
      "Order placed",
      `Your Shop order ${orderId} has been placed and is awaiting payment confirmation.`,
      { orderId }
    );

    sendJson(res, 201, { ...order, dialUssd });
  } catch (err: any) {
    if (err?.code === "23505" && err?.constraint === "idx_shop_orders_client_request_id") {
      const existing = await queryOne<{ id: string }>(`SELECT id FROM shop_orders WHERE client_request_id=$1`, [
        clientRequestId,
      ]);
      if (existing) return sendJson(res, 200, await loadOrderWithItems(existing.id));
    }
    if (typeof err?.statusCode === "number") return sendJson(res, err.statusCode, { error: err.message });
    throw err;
  }
});

shopRouter.get("/shop/orders", requireAuth("customer"), async (req, res) => {
  const orders = await query(`${ORDER_SELECT} WHERE o.customer_id=$1 ORDER BY o.created_at DESC LIMIT 100`, [
    req.auth!.sub,
  ]);
  const ids = orders.map((o: any) => o.id);
  const items = ids.length
    ? await query(
        `SELECT id, order_id, product_id, product_name, unit_price, quantity, subtotal, size, color
         FROM shop_order_items WHERE order_id = ANY($1)`,
        [ids]
      )
    : [];
  sendJson(
    res,
    200,
    orders.map((o: any) => ({ ...o, items: items.filter((i: any) => i.order_id === o.id) }))
  );
});

shopRouter.get("/shop/orders/:id", requireAuth("customer"), async (req, res) => {
  const order = await queryOne(`${ORDER_SELECT} WHERE o.id=$1 AND o.customer_id=$2`, [req.params.id, req.auth!.sub]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  const items = await query(
    `SELECT id, product_id, product_name, unit_price, quantity, subtotal, size, color FROM shop_order_items WHERE order_id=$1`,
    [req.params.id]
  );
  sendJson(res, 200, { ...order, items });
});

// ---------------- Favorites ----------------

shopRouter.get("/shop/favorites", requireAuth("customer"), async (req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT p.id, p.category_id, p.name, p.price, p.discount_price, p.stock
       FROM shop_favorites f JOIN shop_products p ON p.id = f.product_id
       WHERE f.customer_id=$1 AND p.active=true ORDER BY f.created_at DESC`,
      [req.auth!.sub]
    )
  );
});

shopRouter.post("/shop/favorites", requireAuth("customer"), async (req, res) => {
  const productId = String(req.body?.productId ?? "");
  if (!productId) return sendJson(res, 400, { error: "productId is required" });
  await query(
    `INSERT INTO shop_favorites (customer_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [req.auth!.sub, productId]
  );
  sendJson(res, 201, { favorited: true });
});

shopRouter.delete("/shop/favorites/:productId", requireAuth("customer"), async (req, res) => {
  await query(`DELETE FROM shop_favorites WHERE customer_id=$1 AND product_id=$2`, [
    req.auth!.sub,
    req.params.productId,
  ]);
  sendJson(res, 200, { favorited: false });
});

// ---------------- Reviews ----------------

// Gated on ownership: the order item must belong to a DELIVERED order that
// belongs to this customer. The unique constraint on shop_reviews.order_item_id
// stops the same purchase being reviewed twice; catching the resulting 23505
// below turns that into a clean 409 instead of a 500.
shopRouter.post("/shop/reviews", requireAuth("customer"), async (req, res) => {
  const orderItemId = String(req.body?.orderItemId ?? "");
  const rating = Number(req.body?.rating);
  if (!orderItemId || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return sendJson(res, 400, { error: "orderItemId and an integer rating 1-5 are required" });
  }

  const eligible = await queryOne<{ product_id: string }>(
    `SELECT oi.product_id FROM shop_order_items oi
     JOIN shop_orders o ON o.id = oi.order_id
     WHERE oi.id=$1 AND o.customer_id=$2 AND o.status='delivered'`,
    [orderItemId, req.auth!.sub]
  );
  if (!eligible) {
    return sendJson(res, 403, { error: "You can only review products from your own delivered orders" });
  }

  const photo = req.body?.photoBase64 ? parseDataUri(req.body.photoBase64) : null;
  try {
    const id = randomUUID();
    await query(
      `INSERT INTO shop_reviews (id, customer_id, product_id, order_item_id, rating, review_text, photo_data, photo_mime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        req.auth!.sub,
        eligible.product_id,
        orderItemId,
        rating,
        req.body?.reviewText ? String(req.body.reviewText) : "",
        photo?.data ?? null,
        photo?.mimeType ?? null,
      ]
    );
    sendJson(res, 201, await queryOne(`SELECT id, rating, review_text, created_at FROM shop_reviews WHERE id=$1`, [id]));
  } catch (err: any) {
    if (err?.code === "23505") return sendJson(res, 409, { error: "You've already reviewed this purchase" });
    throw err;
  }
});

// ---------------- Returns / Exchanges / Refunds ----------------

shopRouter.post("/shop/returns", requireAuth("customer"), async (req, res) => {
  const orderId = String(req.body?.orderId ?? "");
  const type = String(req.body?.type ?? "");
  if (!["return", "exchange", "refund"].includes(type)) {
    return sendJson(res, 400, { error: "type must be one of return, exchange, refund" });
  }
  const order = await queryOne(`SELECT id FROM shop_orders WHERE id=$1 AND customer_id=$2 AND status='delivered'`, [
    orderId,
    req.auth!.sub,
  ]);
  if (!order) return sendJson(res, 404, { error: "Order not found, not yours, or not yet delivered" });

  const id = randomUUID();
  await query(
    `INSERT INTO shop_returns (id, order_id, customer_id, type, reason) VALUES ($1,$2,$3,$4,$5)`,
    [id, orderId, req.auth!.sub, type, req.body?.reason ? String(req.body.reason) : ""]
  );
  sendJson(res, 201, await queryOne(`SELECT * FROM shop_returns WHERE id=$1`, [id]));
});

shopRouter.get("/shop/returns", requireAuth("customer"), async (req, res) => {
  sendJson(
    res,
    200,
    await query(`SELECT * FROM shop_returns WHERE customer_id=$1 ORDER BY created_at DESC`, [req.auth!.sub])
  );
});

// ---------------- Back-in-stock ----------------

shopRouter.post("/shop/stock-notify", requireAuth("customer"), async (req, res) => {
  const productId = String(req.body?.productId ?? "");
  if (!productId) return sendJson(res, 400, { error: "productId is required" });
  await query(
    `INSERT INTO shop_stock_notify_requests (id, customer_id, product_id) VALUES ($1,$2,$3)
     ON CONFLICT (customer_id, product_id) DO UPDATE SET notified=false`,
    [randomUUID(), req.auth!.sub, productId]
  );
  sendJson(res, 201, { subscribed: true });
});
