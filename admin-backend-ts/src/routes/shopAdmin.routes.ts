import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { parseDataUri } from "../utils/dataUri.js";
import { notifyCustomer } from "../services/customerNotify.js";

export const shopAdminRouter = Router();

// ---------------- Categories (the 5 are fixed -- edit only, no add/delete) ----------------

shopAdminRouter.get("/admin/shop/categories", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM shop_categories ORDER BY position`));
});

shopAdminRouter.put("/admin/shop/categories/:id", requireStaff(), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM shop_categories WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Category not found" });
  const { name, emoji, position, active } = req.body ?? {};
  await query(
    `UPDATE shop_categories SET
       name = COALESCE($1, name), emoji = COALESCE($2, emoji),
       position = COALESCE($3, position), active = COALESCE($4, active), updated_at = now()
     WHERE id=$5`,
    [name ?? null, emoji ?? null, typeof position === "number" ? position : null, typeof active === "boolean" ? active : null, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM shop_categories WHERE id=$1`, [req.params.id]));
});

// ---------------- Electronics subcategories (fully dynamic) ----------------

shopAdminRouter.get("/admin/shop/electronics-subcategories", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM shop_electronics_subcategories ORDER BY position, name`));
});

shopAdminRouter.post("/admin/shop/electronics-subcategories", requireStaff(), async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return sendJson(res, 400, { error: "name is required" });
  const id = randomUUID();
  await query(
    `INSERT INTO shop_electronics_subcategories (id, name, position) VALUES ($1,$2,$3)`,
    [id, name, Number(req.body?.position) || 0]
  );
  sendJson(res, 201, await queryOne(`SELECT * FROM shop_electronics_subcategories WHERE id=$1`, [id]));
});

shopAdminRouter.put("/admin/shop/electronics-subcategories/:id", requireStaff(), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM shop_electronics_subcategories WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Subcategory not found" });
  const { name, position, active } = req.body ?? {};
  await query(
    `UPDATE shop_electronics_subcategories SET
       name = COALESCE($1, name), position = COALESCE($2, position), active = COALESCE($3, active), updated_at = now()
     WHERE id=$4`,
    [name ?? null, typeof position === "number" ? position : null, typeof active === "boolean" ? active : null, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM shop_electronics_subcategories WHERE id=$1`, [req.params.id]));
});

shopAdminRouter.delete("/admin/shop/electronics-subcategories/:id", requireStaff(), async (req, res) => {
  const result = await query(`DELETE FROM shop_electronics_subcategories WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Subcategory not found" });
  sendJson(res, 200, { deleted: true });
});

// ---------------- Brands ----------------

shopAdminRouter.get("/admin/shop/brands", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM shop_brands ORDER BY name`));
});

shopAdminRouter.post("/admin/shop/brands", requireStaff(), async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return sendJson(res, 400, { error: "name is required" });
  const id = randomUUID();
  try {
    await query(`INSERT INTO shop_brands (id, name) VALUES ($1,$2)`, [id, name]);
  } catch (err: any) {
    if (err?.code === "23505") return sendJson(res, 409, { error: "A brand with this name already exists" });
    throw err;
  }
  sendJson(res, 201, await queryOne(`SELECT * FROM shop_brands WHERE id=$1`, [id]));
});

shopAdminRouter.put("/admin/shop/brands/:id", requireStaff(), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM shop_brands WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Brand not found" });
  const { name, active } = req.body ?? {};
  await query(`UPDATE shop_brands SET name = COALESCE($1, name), active = COALESCE($2, active) WHERE id=$3`, [
    name ?? null,
    typeof active === "boolean" ? active : null,
    req.params.id,
  ]);
  sendJson(res, 200, await queryOne(`SELECT * FROM shop_brands WHERE id=$1`, [req.params.id]));
});

shopAdminRouter.delete("/admin/shop/brands/:id", requireStaff(), async (req, res) => {
  const result = await query(`DELETE FROM shop_brands WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Brand not found" });
  sendJson(res, 200, { deleted: true });
});

// ---------------- Products ----------------

const ADMIN_PRODUCT_COLUMNS = `
  id, category_id, subcategory_id, brand_id, name, description, price, discount_price,
  stock, low_stock_threshold, sizes, colors, is_featured, is_new_arrival, is_best_seller,
  active, created_at, updated_at
`;

shopAdminRouter.get("/admin/shop/products", requireStaff(), async (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (req.query.categoryId) {
    params.push(String(req.query.categoryId));
    where.push(`category_id = $${params.length}`);
  }
  if (req.query.lowStock === "true") where.push(`stock <= low_stock_threshold`);
  const sql = `SELECT ${ADMIN_PRODUCT_COLUMNS} FROM shop_products ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`;
  sendJson(res, 200, await query(sql, params));
});

shopAdminRouter.post("/admin/shop/products", requireStaff(), async (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim();
  const categoryId = String(b.categoryId ?? "");
  const price = Number(b.price);
  if (!name || !categoryId || !Number.isFinite(price) || price < 0) {
    return sendJson(res, 400, { error: "name, categoryId, and a non-negative price are required" });
  }
  if (b.subcategoryId && categoryId !== "electronics") {
    return sendJson(res, 400, { error: "subcategoryId only applies to the Electronics category" });
  }
  const category = await queryOne(`SELECT id FROM shop_categories WHERE id=$1`, [categoryId]);
  if (!category) return sendJson(res, 404, { error: "Category not found" });

  const id = randomUUID();
  await query(
    `INSERT INTO shop_products (
       id, category_id, subcategory_id, brand_id, name, description, price, discount_price,
       stock, low_stock_threshold, sizes, colors, is_featured, is_new_arrival, is_best_seller, active
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id,
      categoryId,
      b.subcategoryId ?? null,
      b.brandId ?? null,
      name,
      b.description ?? "",
      price,
      b.discountPrice != null ? Number(b.discountPrice) : null,
      Number.isInteger(b.stock) ? b.stock : 0,
      Number.isInteger(b.lowStockThreshold) ? b.lowStockThreshold : 5,
      Array.isArray(b.sizes) ? b.sizes.map(String) : [],
      Array.isArray(b.colors) ? b.colors.map(String) : [],
      b.isFeatured === true,
      b.isNewArrival === true,
      b.isBestSeller === true,
      b.active !== false,
    ]
  );
  sendJson(res, 201, await queryOne(`SELECT ${ADMIN_PRODUCT_COLUMNS} FROM shop_products WHERE id=$1`, [id]));
});

shopAdminRouter.put("/admin/shop/products/:id", requireStaff(), async (req, res) => {
  const existing = await queryOne<{ id: string; stock: number }>(`SELECT id, stock FROM shop_products WHERE id=$1`, [
    req.params.id,
  ]);
  if (!existing) return sendJson(res, 404, { error: "Product not found" });
  const b = req.body ?? {};

  const wasOutOfStock = existing.stock <= 0;
  await query(
    `UPDATE shop_products SET
       category_id = COALESCE($1, category_id), subcategory_id = COALESCE($2, subcategory_id),
       brand_id = COALESCE($3, brand_id), name = COALESCE($4, name), description = COALESCE($5, description),
       price = COALESCE($6, price), discount_price = CASE WHEN $7::boolean THEN $8 ELSE discount_price END,
       stock = COALESCE($9, stock), low_stock_threshold = COALESCE($10, low_stock_threshold),
       sizes = COALESCE($11, sizes), colors = COALESCE($12, colors),
       is_featured = COALESCE($13, is_featured), is_new_arrival = COALESCE($14, is_new_arrival),
       is_best_seller = COALESCE($15, is_best_seller), active = COALESCE($16, active), updated_at = now()
     WHERE id=$17`,
    [
      b.categoryId ?? null,
      b.subcategoryId ?? null,
      b.brandId ?? null,
      b.name ?? null,
      b.description ?? null,
      b.price != null ? Number(b.price) : null,
      Object.prototype.hasOwnProperty.call(b, "discountPrice"),
      b.discountPrice != null ? Number(b.discountPrice) : null,
      Number.isInteger(b.stock) ? b.stock : null,
      Number.isInteger(b.lowStockThreshold) ? b.lowStockThreshold : null,
      Array.isArray(b.sizes) ? b.sizes.map(String) : null,
      Array.isArray(b.colors) ? b.colors.map(String) : null,
      typeof b.isFeatured === "boolean" ? b.isFeatured : null,
      typeof b.isNewArrival === "boolean" ? b.isNewArrival : null,
      typeof b.isBestSeller === "boolean" ? b.isBestSeller : null,
      typeof b.active === "boolean" ? b.active : null,
      req.params.id,
    ]
  );

  // Restock crossing 0 -> positive: fire back-in-stock pushes to everyone
  // who asked, then mark them notified so this doesn't repeat next edit.
  if (wasOutOfStock && Number.isInteger(b.stock) && b.stock > 0) {
    const subscribers = await query<{ customer_id: string }>(
      `SELECT customer_id FROM shop_stock_notify_requests WHERE product_id=$1 AND notified=false`,
      [req.params.id]
    );
    const product = await queryOne<{ name: string }>(`SELECT name FROM shop_products WHERE id=$1`, [req.params.id]);
    for (const s of subscribers) {
      await notifyCustomer(s.customer_id, "shop_back_in_stock", "Back in stock", `${product?.name ?? "An item on your wishlist"} is back in stock!`, {
        productId: req.params.id,
      });
    }
    await query(`UPDATE shop_stock_notify_requests SET notified=true WHERE product_id=$1`, [req.params.id]);
  }

  sendJson(res, 200, await queryOne(`SELECT ${ADMIN_PRODUCT_COLUMNS} FROM shop_products WHERE id=$1`, [req.params.id]));
});

shopAdminRouter.delete("/admin/shop/products/:id", requireStaff(), async (req, res) => {
  // Soft delete (active=false), not a real DELETE -- shop_order_items.product_id
  // references this row from every past order's receipt.
  const result = await query(`UPDATE shop_products SET active=false, updated_at=now() WHERE id=$1 RETURNING id`, [
    req.params.id,
  ]);
  if (result.length === 0) return sendJson(res, 404, { error: "Product not found" });
  sendJson(res, 200, { deactivated: true });
});

shopAdminRouter.get("/admin/shop/products/:id/images", requireStaff(), async (req, res) => {
  sendJson(
    res,
    200,
    await query(`SELECT id, position, mime_type FROM shop_product_images WHERE product_id=$1 ORDER BY position`, [
      req.params.id,
    ])
  );
});

shopAdminRouter.post("/admin/shop/products/:id/images", requireStaff(), async (req, res) => {
  const product = await queryOne(`SELECT id FROM shop_products WHERE id=$1`, [req.params.id]);
  if (!product) return sendJson(res, 404, { error: "Product not found" });
  const parsed = parseDataUri(req.body?.imageBase64);
  if (!parsed) return sendJson(res, 400, { error: "imageBase64 must be a data:<mime>;base64,<data> string" });

  const id = randomUUID();
  const maxPos = await queryOne<{ m: number }>(`SELECT COALESCE(MAX(position), -1) AS m FROM shop_product_images WHERE product_id=$1`, [
    req.params.id,
  ]);
  await query(`INSERT INTO shop_product_images (id, product_id, image_data, mime_type, position) VALUES ($1,$2,$3,$4,$5)`, [
    id,
    req.params.id,
    parsed.data,
    parsed.mimeType,
    (maxPos?.m ?? -1) + 1,
  ]);
  sendJson(res, 201, { id, position: (maxPos?.m ?? -1) + 1 });
});

shopAdminRouter.delete("/admin/shop/products/:productId/images/:imageId", requireStaff(), async (req, res) => {
  const result = await query(`DELETE FROM shop_product_images WHERE id=$1 AND product_id=$2 RETURNING id`, [
    req.params.imageId,
    req.params.productId,
  ]);
  if (result.length === 0) return sendJson(res, 404, { error: "Image not found" });
  sendJson(res, 200, { deleted: true });
});

// ---------------- Orders ----------------

shopAdminRouter.get("/admin/shop/orders", requireStaff(), async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const params: unknown[] = [];
  let sql = `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone FROM shop_orders o JOIN customers c ON c.id = o.customer_id`;
  if (status) {
    params.push(status);
    sql += ` WHERE o.status=$1`;
  }
  sql += ` ORDER BY o.created_at DESC LIMIT 200`;
  sendJson(res, 200, await query(sql, params));
});

shopAdminRouter.get("/admin/shop/orders/:id", requireStaff(), async (req, res) => {
  const order = await queryOne(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone FROM shop_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id=$1`,
    [req.params.id]
  );
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  const items = await query(`SELECT * FROM shop_order_items WHERE order_id=$1`, [req.params.id]);
  sendJson(res, 200, { ...order, items });
});

const NOTIFY_COPY: Record<string, { type: string; title: string; body: (id: string) => string }> = {
  processing: { type: "shop_order_processing", title: "Order is processing", body: (id) => `Your order ${id} is now being processed.` },
  shipped: { type: "shop_order_shipped", title: "Order shipped", body: (id) => `Your order ${id} has shipped and is on its way.` },
  delivered: { type: "shop_order_delivered", title: "Order delivered", body: (id) => `Your order ${id} has been delivered. Enjoy!` },
  cancelled: { type: "shop_order_cancelled", title: "Order cancelled", body: (id) => `Your order ${id} has been cancelled.` },
  failed: { type: "shop_order_failed", title: "Order failed", body: (id) => `Your order ${id} could not be completed.` },
  returned: { type: "shop_order_returned", title: "Order returned", body: (id) => `Your order ${id} has been marked as returned.` },
  refunded: { type: "shop_order_refunded", title: "Order refunded", body: (id) => `Your order ${id} has been refunded.` },
};

const RESTOCK_ON = new Set(["cancelled", "failed", "returned", "refunded"]);

shopAdminRouter.put("/admin/shop/orders/:id/status", requireStaff(), async (req, res) => {
  const status = String(req.body?.status ?? "");
  const validStatuses = ["pending", "processing", "shipped", "delivered", "cancelled", "failed", "returned", "refunded"];
  if (!validStatuses.includes(status)) return sendJson(res, 400, { error: `status must be one of ${validStatuses.join(", ")}` });

  const order = await queryOne<{ id: string; status: string; customer_id: string; payment_status: string }>(
    `SELECT id, status, customer_id, payment_status FROM shop_orders WHERE id=$1`,
    [req.params.id]
  );
  if (!order) return sendJson(res, 404, { error: "Order not found" });

  const courierName = req.body?.courierName != null ? String(req.body.courierName) : null;
  const trackingReference = req.body?.trackingReference != null ? String(req.body.trackingReference) : null;
  const trackingNote = req.body?.trackingNote != null ? String(req.body.trackingNote) : null;

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE shop_orders SET
         status=$1,
         courier_name = COALESCE($2, courier_name),
         tracking_reference = COALESCE($3, tracking_reference),
         tracking_note = COALESCE($4, tracking_note),
         payment_status = CASE WHEN $1 = 'delivered' THEN 'paid' ELSE payment_status END,
         updated_at = now()
       WHERE id=$5`,
      [status, courierName, trackingReference, trackingNote, req.params.id]
    );

    // Stock was deducted at order-creation time (see POST /shop/orders); a
    // terminal non-fulfillment status must give it back exactly once. The
    // status check stops a second cancel-after-cancel (already
    // impossible via the UI, but not via a replayed API call) from
    // double-crediting stock.
    if (RESTOCK_ON.has(status) && !RESTOCK_ON.has(order.status)) {
      const items = await client.query(`SELECT product_id, quantity FROM shop_order_items WHERE order_id=$1`, [
        req.params.id,
      ]);
      for (const item of items.rows) {
        if (item.product_id) {
          await client.query(`UPDATE shop_products SET stock = stock + $1 WHERE id=$2`, [item.quantity, item.product_id]);
        }
      }
    }
  });

  const copy = NOTIFY_COPY[status];
  if (copy) await notifyCustomer(order.customer_id, copy.type, copy.title, copy.body(order.id));

  sendJson(res, 200, await queryOne(`SELECT * FROM shop_orders WHERE id=$1`, [req.params.id]));
});

// ---------------- Returns / Exchanges / Refunds ----------------

shopAdminRouter.get("/admin/shop/returns", requireStaff(), async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const params: unknown[] = [];
  let sql = `SELECT r.*, c.name AS customer_name, c.phone AS customer_phone FROM shop_returns r JOIN customers c ON c.id = r.customer_id`;
  if (status) {
    params.push(status);
    sql += ` WHERE r.status=$1`;
  }
  sql += ` ORDER BY r.created_at DESC`;
  sendJson(res, 200, await query(sql, params));
});

shopAdminRouter.put("/admin/shop/returns/:id", requireStaff(), async (req, res) => {
  const status = String(req.body?.status ?? "");
  const validStatuses = ["requested", "approved", "rejected", "processing", "completed"];
  if (!validStatuses.includes(status)) return sendJson(res, 400, { error: `status must be one of ${validStatuses.join(", ")}` });
  const existing = await queryOne<{ id: string; customer_id: string; type: string }>(
    `SELECT id, customer_id, type FROM shop_returns WHERE id=$1`,
    [req.params.id]
  );
  if (!existing) return sendJson(res, 404, { error: "Return request not found" });

  await query(
    `UPDATE shop_returns SET status=$1, admin_note = COALESCE($2, admin_note), updated_at=now() WHERE id=$3`,
    [status, req.body?.adminNote ?? null, req.params.id]
  );
  await notifyCustomer(
    existing.customer_id,
    "shop_return_update",
    `${existing.type[0].toUpperCase()}${existing.type.slice(1)} request updated`,
    `Your ${existing.type} request is now: ${status}.`
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM shop_returns WHERE id=$1`, [req.params.id]));
});

// ---------------- Promo codes ----------------

shopAdminRouter.get("/admin/shop/promo-codes", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM shop_promo_codes ORDER BY created_at DESC`));
});

shopAdminRouter.post("/admin/shop/promo-codes", requireStaff(), async (req, res) => {
  const b = req.body ?? {};
  const code = String(b.code ?? "").trim().toUpperCase();
  const discountType = String(b.discountType ?? "");
  const discountValue = Number(b.discountValue);
  if (!code || !["percent", "fixed"].includes(discountType) || !Number.isFinite(discountValue) || discountValue <= 0) {
    return sendJson(res, 400, { error: "code, discountType (percent|fixed), and a positive discountValue are required" });
  }
  const id = randomUUID();
  try {
    await query(
      `INSERT INTO shop_promo_codes (id, code, discount_type, discount_value, min_order_amount, usage_limit, starts_at, ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, code, discountType, discountValue, Number(b.minOrderAmount) || 0, Number.isInteger(b.usageLimit) ? b.usageLimit : null, b.startsAt ?? null, b.endsAt ?? null]
    );
  } catch (err: any) {
    if (err?.code === "23505") return sendJson(res, 409, { error: "This promo code already exists" });
    throw err;
  }
  sendJson(res, 201, await queryOne(`SELECT * FROM shop_promo_codes WHERE id=$1`, [id]));
});

shopAdminRouter.put("/admin/shop/promo-codes/:id", requireStaff(), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM shop_promo_codes WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Promo code not found" });
  const b = req.body ?? {};
  await query(
    `UPDATE shop_promo_codes SET
       active = COALESCE($1, active), discount_value = COALESCE($2, discount_value),
       min_order_amount = COALESCE($3, min_order_amount), usage_limit = COALESCE($4, usage_limit),
       ends_at = COALESCE($5, ends_at)
     WHERE id=$6`,
    [typeof b.active === "boolean" ? b.active : null, b.discountValue != null ? Number(b.discountValue) : null, b.minOrderAmount != null ? Number(b.minOrderAmount) : null, Number.isInteger(b.usageLimit) ? b.usageLimit : null, b.endsAt ?? null, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM shop_promo_codes WHERE id=$1`, [req.params.id]));
});

shopAdminRouter.delete("/admin/shop/promo-codes/:id", requireStaff(), async (req, res) => {
  const result = await query(`DELETE FROM shop_promo_codes WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Promo code not found" });
  sendJson(res, 200, { deleted: true });
});

// ---------------- Flash sales ----------------

shopAdminRouter.get("/admin/shop/flash-sales", requireStaff(), async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT fs.*, p.name AS product_name FROM shop_flash_sales fs JOIN shop_products p ON p.id = fs.product_id ORDER BY fs.starts_at DESC`
    )
  );
});

shopAdminRouter.post("/admin/shop/flash-sales", requireStaff(), async (req, res) => {
  const b = req.body ?? {};
  const productId = String(b.productId ?? "");
  const discountPrice = Number(b.discountPrice);
  if (!productId || !Number.isFinite(discountPrice) || discountPrice < 0 || !b.startsAt || !b.endsAt) {
    return sendJson(res, 400, { error: "productId, discountPrice, startsAt, and endsAt are required" });
  }
  const product = await queryOne<{ id: string; name: string }>(`SELECT id, name FROM shop_products WHERE id=$1`, [productId]);
  if (!product) return sendJson(res, 404, { error: "Product not found" });

  const id = randomUUID();
  await query(
    `INSERT INTO shop_flash_sales (id, product_id, discount_price, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5)`,
    [id, productId, discountPrice, b.startsAt, b.endsAt]
  );

  // "New offer is available" -- best-effort broadcast to every customer who
  // has favorited this product; a store-wide blast belongs to
  // notifications.routes.ts's existing broadcast tool, not this endpoint.
  const interested = await query<{ customer_id: string }>(`SELECT customer_id FROM shop_favorites WHERE product_id=$1`, [productId]);
  for (const c of interested) {
    await notifyCustomer(c.customer_id, "shop_new_offer", "Flash sale!", `${product.name} is now on flash sale.`, { productId });
  }

  sendJson(res, 201, await queryOne(`SELECT * FROM shop_flash_sales WHERE id=$1`, [id]));
});

shopAdminRouter.put("/admin/shop/flash-sales/:id", requireStaff(), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM shop_flash_sales WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Flash sale not found" });
  const b = req.body ?? {};
  await query(
    `UPDATE shop_flash_sales SET
       active = COALESCE($1, active), discount_price = COALESCE($2, discount_price),
       starts_at = COALESCE($3, starts_at), ends_at = COALESCE($4, ends_at)
     WHERE id=$5`,
    [typeof b.active === "boolean" ? b.active : null, b.discountPrice != null ? Number(b.discountPrice) : null, b.startsAt ?? null, b.endsAt ?? null, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM shop_flash_sales WHERE id=$1`, [req.params.id]));
});

shopAdminRouter.delete("/admin/shop/flash-sales/:id", requireStaff(), async (req, res) => {
  const result = await query(`DELETE FROM shop_flash_sales WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Flash sale not found" });
  sendJson(res, 200, { deleted: true });
});

// ---------------- Payment methods (super_admin only -- controls what the app dials) ----------------

shopAdminRouter.get("/admin/shop/payment-methods", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM shop_payment_methods ORDER BY sort_order, label`));
});

shopAdminRouter.post("/admin/shop/payment-methods", requireAuth("super_admin"), async (req, res) => {
  const b = req.body ?? {};
  const method = String(b.method ?? "").trim().toLowerCase();
  const label = String(b.label ?? "").trim();
  if (!method || !label) return sendJson(res, 400, { error: "method and label are required" });
  if (b.deviceId && !(await queryOne(`SELECT id FROM agent_devices WHERE id=$1`, [b.deviceId]))) {
    return sendJson(res, 404, { error: "Device not found" });
  }
  const id = randomUUID();
  await query(
    `INSERT INTO shop_payment_methods (id, method, label, payment_number, ussd_template, sort_order, device_id, sim_slot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, method, label, b.paymentNumber ?? null, b.ussdTemplate ?? null, Number(b.sortOrder) || 0, b.deviceId || null, Number.isInteger(b.simSlot) ? b.simSlot : null]
  );
  sendJson(res, 201, await queryOne(`SELECT * FROM shop_payment_methods WHERE id=$1`, [id]));
});

// deviceId/simSlot: which Agent App device collects this method's payments
// -- resolves "the assigned Shop Agent" for the real-time payment-received
// push (shopSmsMatching.ts). Admin can set this up front, or leave it blank
// and let the first successful SMS match auto-link it (same bootstrap
// company_payment_methods/reseller_deposit_methods already have).
shopAdminRouter.put("/admin/shop/payment-methods/:id", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM shop_payment_methods WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Payment method not found" });
  const b = req.body ?? {};
  if (b.deviceId && !(await queryOne(`SELECT id FROM agent_devices WHERE id=$1`, [b.deviceId]))) {
    return sendJson(res, 404, { error: "Device not found" });
  }
  await query(
    `UPDATE shop_payment_methods SET
       label = COALESCE($1, label), payment_number = COALESCE($2, payment_number),
       ussd_template = COALESCE($3, ussd_template), enabled = COALESCE($4, enabled),
       sort_order = COALESCE($5, sort_order), device_id = COALESCE($6, device_id),
       sim_slot = COALESCE($7, sim_slot), updated_at = now()
     WHERE id=$8`,
    [
      b.label ?? null, b.paymentNumber ?? null, b.ussdTemplate ?? null, typeof b.enabled === "boolean" ? b.enabled : null,
      Number.isInteger(b.sortOrder) ? b.sortOrder : null, b.deviceId ?? null, Number.isInteger(b.simSlot) ? b.simSlot : null,
      req.params.id,
    ]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM shop_payment_methods WHERE id=$1`, [req.params.id]));
});

shopAdminRouter.delete("/admin/shop/payment-methods/:id", requireAuth("super_admin"), async (req, res) => {
  const result = await query(`DELETE FROM shop_payment_methods WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Payment method not found" });
  sendJson(res, 200, { deleted: true });
});

// ---------------- Settings (Open/Closed schedule) ----------------

shopAdminRouter.get("/admin/shop/settings", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await queryOne(`SELECT * FROM shop_settings WHERE id=1`));
});

shopAdminRouter.put("/admin/shop/settings", requireAuth("super_admin"), async (req, res) => {
  const b = req.body ?? {};
  if (b.manualOverride != null && !["open", "closed"].includes(b.manualOverride)) {
    return sendJson(res, 400, { error: "manualOverride must be 'open', 'closed', or null" });
  }
  await query(
    `UPDATE shop_settings SET
       working_days = COALESCE($1, working_days), opening_time = COALESCE($2, opening_time),
       closing_time = COALESCE($3, closing_time),
       manual_override = CASE WHEN $4::boolean THEN $5 ELSE manual_override END,
       updated_at = now()
     WHERE id=1`,
    [
      Array.isArray(b.workingDays) ? b.workingDays.map(Number) : null,
      b.openingTime ?? null,
      b.closingTime ?? null,
      Object.prototype.hasOwnProperty.call(b, "manualOverride"),
      b.manualOverride ?? null,
    ]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM shop_settings WHERE id=1`));
});

// ---------------- Analytics ----------------

shopAdminRouter.get("/admin/shop/analytics", requireStaff(), async (_req, res) => {
  const [totals, bestProducts, bestCategories, lowStock, revenueByDate] = await Promise.all([
    queryOne(`
      SELECT
        COUNT(*) AS total_orders,
        COUNT(*) FILTER (WHERE status = 'delivered') AS completed_orders,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_orders,
        COALESCE(SUM(total_amount) FILTER (WHERE status <> 'cancelled' AND status <> 'failed'), 0) AS total_sales
      FROM shop_orders
    `),
    query(`
      SELECT oi.product_name, SUM(oi.quantity) AS units_sold, SUM(oi.subtotal) AS revenue
      FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
      WHERE o.status <> 'cancelled' AND o.status <> 'failed'
      GROUP BY oi.product_name ORDER BY units_sold DESC LIMIT 10
    `),
    query(`
      SELECT p.category_id, SUM(oi.quantity) AS units_sold, SUM(oi.subtotal) AS revenue
      FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
      JOIN shop_products p ON p.id = oi.product_id
      WHERE o.status <> 'cancelled' AND o.status <> 'failed'
      GROUP BY p.category_id ORDER BY revenue DESC
    `),
    query(`SELECT id, name, stock, low_stock_threshold FROM shop_products WHERE active=true AND stock <= low_stock_threshold ORDER BY stock ASC`),
    query(`
      SELECT date_trunc('day', created_at) AS date, SUM(total_amount) AS revenue, COUNT(*) AS orders
      FROM shop_orders WHERE status <> 'cancelled' AND status <> 'failed' AND created_at > now() - interval '30 days'
      GROUP BY date_trunc('day', created_at) ORDER BY date
    `),
  ]);

  const bestElectronicsSubcategories = await query(`
    SELECT s.name, SUM(oi.quantity) AS units_sold, SUM(oi.subtotal) AS revenue
    FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
    JOIN shop_products p ON p.id = oi.product_id
    JOIN shop_electronics_subcategories s ON s.id = p.subcategory_id
    WHERE o.status <> 'cancelled' AND o.status <> 'failed'
    GROUP BY s.name ORDER BY revenue DESC LIMIT 10
  `);

  sendJson(res, 200, {
    ...totals,
    bestProducts,
    bestCategories,
    bestElectronicsSubcategories,
    lowStockProducts: lowStock,
    revenueByDate,
  });
});
