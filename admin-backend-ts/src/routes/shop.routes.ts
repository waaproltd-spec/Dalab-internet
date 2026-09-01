import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { rateLimit } from "../auth/rateLimit.js";
import { sendJson } from "../utils/camelCase.js";
import { parseDataUri } from "../utils/dataUri.js";
import { notifyCustomer } from "../services/customerNotify.js";
import { recordActivity } from "../utils/activityLog.js";

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

const MAX_PRODUCT_IMAGES = 6;

function generateShopOrderId(): string {
  return "SHP" + Math.floor(100000000 + Math.random() * 900000000);
}

// ==================== Public catalog (no auth — browsing before login) ====================

const CATEGORY_COLUMNS = "id, name, emoji, position, active";
const PRODUCT_COLUMNS = "id, category_id, name, description, price, stock, active, created_at";

shopRouter.get("/shop/categories", async (_req, res) => {
  sendJson(res, 200, await query(`SELECT ${CATEGORY_COLUMNS} FROM shop_categories WHERE active=true ORDER BY position`));
});

shopRouter.get("/shop/products", async (req, res) => {
  const { categoryId } = req.query;
  const rows = categoryId
    ? await query(
        `SELECT ${PRODUCT_COLUMNS} FROM shop_products WHERE active=true AND category_id=$1 ORDER BY created_at DESC`,
        [categoryId]
      )
    : await query(`SELECT ${PRODUCT_COLUMNS} FROM shop_products WHERE active=true ORDER BY created_at DESC`);
  sendJson(res, 200, rows);
});

shopRouter.get("/shop/products/:id", async (req, res) => {
  const product = await queryOne(`SELECT ${PRODUCT_COLUMNS} FROM shop_products WHERE id=$1 AND active=true`, [req.params.id]);
  if (!product) return sendJson(res, 404, { error: "Product not found" });
  const images = await query(`SELECT id, position FROM shop_product_images WHERE product_id=$1 ORDER BY position`, [req.params.id]);
  sendJson(res, 200, { ...product, images });
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

// Public like /exchange/wallets — the Customer App needs this to build the
// "Dial to Pay" USSD string before checkout, and the payment number/dial
// code here is meant to be dialed by anyone, not a secret.
shopRouter.get("/shop/payment-methods", async (_req, res) => {
  sendJson(res, 200, await query(`SELECT method, label, payment_number, ussd_template FROM shop_payment_methods ORDER BY method`));
});

// ==================== Customer App (self-service) ====================

const SHOP_ORDER_COLUMNS = "id, customer_id, payment_method, sender_phone, delivery_name, delivery_phone, delivery_address, total_amount, payment_status, status, tracking_reference, tracking_note, paid_at, delivered_at, cancelled_at, created_at, updated_at";

async function loadOrderItems(orderId: string) {
  return query(`SELECT id, product_id, product_name, unit_price, quantity, subtotal FROM shop_order_items WHERE order_id=$1`, [orderId]);
}

shopRouter.post(
  "/shop/orders",
  requireAuth("customer"),
  rateLimit("customer-shop-order-create", 20, 15 * 60 * 1000),
  async (req, res) => {
    const { items, paymentMethod, senderPhone, deliveryName, deliveryPhone, deliveryAddress } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return sendJson(res, 400, { error: "Cart is empty — add at least one product" });
    }
    if (!senderPhone) return sendJson(res, 400, { error: "Provide the phone number you'll pay from" });
    if (!deliveryName || !deliveryPhone || !deliveryAddress) {
      return sendJson(res, 400, { error: "deliveryName, deliveryPhone, and deliveryAddress are all required" });
    }
    const method = await queryOne<{ method: string; ussd_template: string }>(
      `SELECT method, ussd_template FROM shop_payment_methods WHERE method=$1`,
      [paymentMethod]
    );
    if (!method) return sendJson(res, 400, { error: "Choose a valid payment method" });

    try {
      const result = await withTransaction(async (client) => {
        const orderId = generateShopOrderId();
        let total = 0;
        const orderItems: { productId: string; productName: string; unitPrice: number; quantity: number; subtotal: number }[] = [];

        for (const raw of items) {
          const productId = String(raw?.productId ?? "");
          const quantity = Number(raw?.quantity);
          if (!productId || !Number.isInteger(quantity) || quantity < 1) {
            throw Object.assign(new Error("Each cart item needs a valid productId and a quantity of at least 1"), { status: 400 });
          }
          // FOR UPDATE: two customers checking out the same low-stock product
          // at once must never both succeed past the stock check below —
          // same "lock the candidate row before touching it" principle used
          // throughout this codebase's other reservation flows.
          const product = await client.query(
            `SELECT id, name, price, stock, active FROM shop_products WHERE id=$1 FOR UPDATE`,
            [productId]
          );
          const row = product.rows[0];
          if (!row || !row.active) {
            throw Object.assign(new Error(`Product ${productId} is no longer available`), { status: 404 });
          }
          if (row.stock < quantity) {
            throw Object.assign(new Error(`Only ${row.stock} of "${row.name}" left in stock`), { status: 409 });
          }
          await client.query(`UPDATE shop_products SET stock = stock - $1, updated_at = now() WHERE id=$2`, [quantity, productId]);
          const unitPrice = Number(row.price);
          const subtotal = Math.round(unitPrice * quantity * 100) / 100;
          total = Math.round((total + subtotal) * 100) / 100;
          orderItems.push({ productId, productName: row.name, unitPrice, quantity, subtotal });
        }

        await client.query(
          `INSERT INTO shop_orders (id, customer_id, payment_method, sender_phone, delivery_name, delivery_phone, delivery_address, total_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [orderId, req.auth!.sub, method.method, senderPhone, deliveryName, deliveryPhone, deliveryAddress, total]
        );
        for (const item of orderItems) {
          await client.query(
            `INSERT INTO shop_order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [randomUUID(), orderId, item.productId, item.productName, item.unitPrice, item.quantity, item.subtotal]
          );
        }
        return { orderId, total };
      });

      const dialUssd = method.ussd_template.replace("{amount}", String(result.total));
      const order = await queryOne(`SELECT ${SHOP_ORDER_COLUMNS} FROM shop_orders WHERE id=$1`, [result.orderId]);
      sendJson(res, 201, { ...order, items: await loadOrderItems(result.orderId), dialUssd });
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
  sendJson(res, 200, { ...order, items: await loadOrderItems(order.id) });
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

// ==================== Admin: Products ====================

shopRouter.get("/admin/shop/products", requirePermission("shop.manage"), async (req, res) => {
  const { categoryId } = req.query;
  const rows = categoryId
    ? await query(`SELECT ${PRODUCT_COLUMNS} FROM shop_products WHERE category_id=$1 ORDER BY created_at DESC`, [categoryId])
    : await query(`SELECT ${PRODUCT_COLUMNS} FROM shop_products ORDER BY created_at DESC`);
  sendJson(res, 200, rows);
});

shopRouter.get("/admin/shop/products/:id", requirePermission("shop.manage"), async (req, res) => {
  const product = await queryOne(`SELECT ${PRODUCT_COLUMNS} FROM shop_products WHERE id=$1`, [req.params.id]);
  if (!product) return sendJson(res, 404, { error: "Product not found" });
  const images = await query(`SELECT id, position FROM shop_product_images WHERE product_id=$1 ORDER BY position`, [req.params.id]);
  sendJson(res, 200, { ...product, images });
});

shopRouter.post("/admin/shop/products", requirePermission("shop.manage"), async (req, res) => {
  const { categoryId, name, description, price, stock } = req.body ?? {};
  if (!categoryId || !name) return sendJson(res, 400, { error: "categoryId and name are required" });
  const priceNum = Number(price);
  const stockNum = stock == null ? 0 : Number(stock);
  if (!Number.isFinite(priceNum) || priceNum < 0) return sendJson(res, 400, { error: "price must be a non-negative number" });
  if (!Number.isInteger(stockNum) || stockNum < 0) return sendJson(res, 400, { error: "stock must be a non-negative whole number" });
  if (!(await queryOne(`SELECT id FROM shop_categories WHERE id=$1`, [categoryId]))) {
    return sendJson(res, 404, { error: "Category not found" });
  }
  const id = randomUUID();
  await query(
    `INSERT INTO shop_products (id, category_id, name, description, price, stock) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, categoryId, String(name).trim(), String(description ?? "").trim(), priceNum, stockNum]
  );
  sendJson(res, 201, await queryOne(`SELECT ${PRODUCT_COLUMNS} FROM shop_products WHERE id=$1`, [id]));
});

shopRouter.put("/admin/shop/products/:id", requirePermission("shop.manage"), async (req, res) => {
  const existing = await queryOne<any>(`SELECT * FROM shop_products WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Product not found" });
  const { categoryId, name, description, price, stock, active } = req.body ?? {};
  if (price !== undefined && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
    return sendJson(res, 400, { error: "price must be a non-negative number" });
  }
  if (stock !== undefined && (!Number.isInteger(Number(stock)) || Number(stock) < 0)) {
    return sendJson(res, 400, { error: "stock must be a non-negative whole number" });
  }
  if (categoryId && !(await queryOne(`SELECT id FROM shop_categories WHERE id=$1`, [categoryId]))) {
    return sendJson(res, 404, { error: "Category not found" });
  }
  await query(
    `UPDATE shop_products SET category_id=$1, name=$2, description=$3, price=$4, stock=$5, active=$6, updated_at=now() WHERE id=$7`,
    [
      categoryId ?? existing.category_id,
      name?.trim() || existing.name,
      description !== undefined ? String(description).trim() : existing.description,
      price !== undefined ? Number(price) : existing.price,
      stock !== undefined ? Number(stock) : existing.stock,
      typeof active === "boolean" ? active : existing.active,
      req.params.id,
    ]
  );
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
  const result = await query(`DELETE FROM shop_product_images WHERE id=$1 AND product_id=$2 RETURNING id`, [req.params.imageId, req.params.productId]);
  if (result.length === 0) return sendJson(res, 404, { error: "Image not found" });
  sendJson(res, 200, { deleted: true });
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
const SHOP_ORDER_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled"];

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
  if (existing.status === "cancelled") return sendJson(res, 409, { error: "This order was cancelled" });

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
  await notifyCustomer(existing.customer_id, "shop_order_update", "Order Confirmed", `Your payment for order ${req.params.id} has been confirmed. We're preparing it now.`);
  sendJson(res, 200, await queryOne(`${SHOP_ORDER_LIST_SELECT} WHERE so.id=$1`, [req.params.id]));
});

const STATUS_NOTIFICATIONS: Record<string, { title: string; body: (id: string) => string }> = {
  processing: { title: "Order Processing", body: (id) => `Order ${id} is being prepared.` },
  shipped: { title: "Order Shipped", body: (id) => `Order ${id} is on its way.` },
  delivered: { title: "Order Delivered", body: (id) => `Order ${id} has been delivered. Thank you for shopping with DALAB!` },
  cancelled: { title: "Order Cancelled", body: (id) => `Order ${id} has been cancelled.` },
};

// Staged delivery tracking: pending -> processing -> shipped -> delivered,
// or cancelled from any non-delivered state. trackingReference/trackingNote
// (e.g. courier name + tracking number) are optional free text an Admin can
// attach at any stage for the customer to see — no courier/GPS integration,
// same manual-staged-update simplicity as the rest of this admin dashboard.
shopRouter.put("/admin/shop/orders/:id/status", requirePermission("shop.manage"), async (req, res) => {
  const { status, trackingReference, trackingNote } = req.body ?? {};
  if (!SHOP_ORDER_STATUSES.includes(status)) return sendJson(res, 400, { error: `status must be one of ${SHOP_ORDER_STATUSES.join(", ")}` });
  const existing = await queryOne<{ status: string; customer_id: string }>(`SELECT status, customer_id FROM shop_orders WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Order not found" });
  if (existing.status === "delivered") return sendJson(res, 409, { error: "This order was already delivered" });
  if (existing.status === "cancelled") return sendJson(res, 409, { error: "This order was already cancelled" });

  // Cancelling releases the stock this order reserved at creation time —
  // same "reverse the reservation, never mutate history" principle
  // reseller_withdrawals uses, applied here by simply crediting the stock
  // back rather than a second ledger row (Shop has no wallet ledger).
  if (status === "cancelled" && existing.status !== "cancelled") {
    const items = await query<{ product_id: string | null; quantity: number }>(`SELECT product_id, quantity FROM shop_order_items WHERE order_id=$1`, [req.params.id]);
    for (const item of items) {
      if (item.product_id) {
        await query(`UPDATE shop_products SET stock = stock + $1, updated_at = now() WHERE id=$2`, [item.quantity, item.product_id]);
      }
    }
  }

  await query(
    `UPDATE shop_orders SET status=$1,
       tracking_reference=COALESCE($2, tracking_reference),
       tracking_note=COALESCE($3, tracking_note),
       delivered_at = CASE WHEN $1='delivered' THEN now() ELSE delivered_at END,
       cancelled_at = CASE WHEN $1='cancelled' THEN now() ELSE cancelled_at END,
       updated_at=now()
     WHERE id=$4`,
    [status, typeof trackingReference === "string" ? trackingReference.trim() : null, typeof trackingNote === "string" ? trackingNote.trim() : null, req.params.id]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "shop_order_status_updated",
    entityType: "shop_order",
    entityId: req.params.id,
    oldValue: { status: existing.status },
    newValue: { status, trackingReference: trackingReference ?? null, trackingNote: trackingNote ?? null },
  });
  const notification = STATUS_NOTIFICATIONS[status];
  if (notification) await notifyCustomer(existing.customer_id, "shop_order_update", notification.title, notification.body(req.params.id));
  sendJson(res, 200, await queryOne(`${SHOP_ORDER_LIST_SELECT} WHERE so.id=$1`, [req.params.id]));
});
