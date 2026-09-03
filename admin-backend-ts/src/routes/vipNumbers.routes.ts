import { Router } from "express";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { rateLimit } from "../auth/rateLimit.js";
import { sendJson } from "../utils/camelCase.js";
import { notifyCustomer } from "../services/customerNotify.js";
import { recordActivity } from "../utils/activityLog.js";
import { formatUssdAmount } from "../utils/ussdFormatting.js";
import { validateMobileNumber } from "../lib/phoneValidation.js";

// VIP Numbers: DALAB's 5th independent customer-facing service (Internet |
// eBadal | Reseller | Shop | VIP Numbers) — a small catalog of premium
// phone numbers (Gold/Silver tier) per company. Checkout, payment
// collection, and Admin verification all reuse Shop's exact pattern (see
// migration 087's header and shop.routes.ts): the customer dials DALAB's
// own collection number themselves via shop_payment_methods, and an Admin
// manually marks the order paid once the money arrives — not a new
// payment system, and not wired into the automatic SMS-matching pipeline
// for the same "brand-new, lower-traffic feature" reasoning Shop used.
//
// Every /admin/vip-numbers/* route below — including plain GETs — requires
// the "vipNumbers.manage" permission, not just requireStaff(), matching
// Shop's own admin section policy.
export const vipNumbersRouter = Router();

const VIP_ORDER_STATUSES = ["pending", "processing", "completed", "cancelled", "failed"];
const TERMINAL_VIP_ORDER_STATUSES = ["completed", "cancelled", "failed"];
const AVAILABILITY_RESTORING_STATUSES = ["cancelled", "failed"];

function generateVipNumberOrderId(): string {
  return "VIP" + Math.floor(100000000 + Math.random() * 900000000);
}

// At least 3 words (given name + father's + grandfather's name, the
// standard Somali full-name convention DALAB's real-world number
// registration/porting needs) — mirrors the same check in migration 087's
// header, enforced here since this is the only place a name is accepted.
function hasThreeNames(name: string): boolean {
  return name.trim().split(/\s+/).filter(Boolean).length >= 3;
}

async function loadOrderStatusHistory(orderId: string) {
  return query(`SELECT status, note, changed_at FROM vip_number_order_status_history WHERE order_id=$1 ORDER BY changed_at ASC`, [orderId]);
}

// Reverses the reservation made at order-creation time — shared by the
// customer-initiated cancel route and the admin status route, same
// "reverse the reservation, never mutate history" principle
// restoreShopOrderStock already uses. Safe against double-restoration:
// both call sites only reach here from a non-terminal order status.
async function restoreVipNumberAvailability(vipNumberId: string) {
  await query(`UPDATE vip_numbers SET status='available', updated_at=now() WHERE id=$1 AND status != 'sold'`, [vipNumberId]);
}

const VIP_ORDER_COLUMNS =
  "id, vip_number_id, customer_id, company_id, phone_number, category, price, customer_full_name, payment_method, sender_phone, payment_status, status, paid_at, completed_at, cancelled_at, created_at, updated_at";

// ==================== Public catalog (no auth — browsing before login) ====================

vipNumbersRouter.get("/vip-numbers", async (req, res) => {
  const { companyId, search } = req.query as { companyId?: string; search?: string };
  const args: unknown[] = [];
  // NOT EXISTS(... vip_number_package_items ...): a number an admin has
  // placed into a Package (see vipNumberPackages.routes.ts, migration 088)
  // is sold only as part of that package, never individually too --
  // otherwise the same physical number could be sold twice through both
  // paths at once. This is the only change this file needed to support
  // packages; everything else here (including this route's own remaining
  // filters/ordering) is unchanged.
  let sql = `SELECT vn.id, vn.company_id, c.name AS company_name, c.color_hex AS company_color_hex,
                    vn.phone_number, vn.category, vn.price
             FROM vip_numbers vn
             JOIN companies c ON c.id = vn.company_id
             WHERE vn.status='available'
               AND NOT EXISTS (SELECT 1 FROM vip_number_package_items pi WHERE pi.vip_number_id = vn.id)`;
  if (companyId) {
    args.push(companyId);
    sql += ` AND vn.company_id=$${args.length}`;
  }
  if (search) {
    args.push(`%${search}%`);
    sql += ` AND vn.phone_number ILIKE $${args.length}`;
  }
  sql += ` ORDER BY vn.category, vn.price DESC, vn.phone_number LIMIT 200`;
  sendJson(res, 200, await query(sql, args));
});

// ==================== Customer orders ====================

vipNumbersRouter.post(
  "/vip-numbers/orders",
  requireAuth("customer"),
  rateLimit("customer-vip-number-order-create", 20, 15 * 60 * 1000),
  async (req, res) => {
    const { vipNumberId, paymentMethod, senderPhone, customerFullName } = req.body ?? {};
    if (!vipNumberId) return sendJson(res, 400, { error: "vipNumberId is required" });
    if (!senderPhone) return sendJson(res, 400, { error: "Provide the phone number you'll pay from" });
    if (typeof customerFullName !== "string" || !hasThreeNames(customerFullName)) {
      return sendJson(res, 400, { error: "Enter your full name (first, father's, and grandfather's name)" });
    }

    const method = await queryOne<{ method: string; ussd_template: string }>(
      `SELECT method, ussd_template FROM shop_payment_methods WHERE method=$1`,
      [paymentMethod]
    );
    if (!method) return sendJson(res, 400, { error: "Choose a valid payment method" });

    // Same carrier-prefix discipline every other purchase flow in this app
    // already enforces — see shop.routes.ts's identical senderCompanyKey
    // mapping/reasoning.
    const senderCompanyKey = method.method === "evc" ? "evc_plus" : method.method;
    const senderCheck = validateMobileNumber(String(senderPhone), senderCompanyKey);
    if (!senderCheck.valid) return sendJson(res, 400, { error: senderCheck.error });

    // A double-tap of "Purchase Number" on the same still-pending order
    // returns the existing order rather than attempting (and failing) a
    // second reservation of an already-reserved number.
    const dup = await queryOne<{ id: string }>(
      `SELECT id FROM vip_number_orders WHERE customer_id=$1 AND vip_number_id=$2 AND status='pending' LIMIT 1`,
      [req.auth!.sub, vipNumberId]
    );

    try {
      const result = dup
        ? { orderId: dup.id, duplicate: true }
        : await withTransaction(async (client) => {
            // FOR UPDATE: two customers tapping "Purchase Number" on the same
            // VIP number at once must never both succeed past the
            // availability check below — same "lock the candidate row
            // before touching it" principle Shop's own stock reservation
            // (and reseller_withdrawals before it) already uses.
            const row = await client.query(
              `SELECT id, company_id, phone_number, category, price, status FROM vip_numbers WHERE id=$1 FOR UPDATE`,
              [vipNumberId]
            );
            const vipNumber = row.rows[0];
            if (!vipNumber) {
              throw Object.assign(new Error("VIP number not found"), { status: 404 });
            }
            if (vipNumber.status !== "available") {
              throw Object.assign(new Error("This number has just been taken by another customer — please choose a different one"), { status: 409 });
            }

            const orderId = generateVipNumberOrderId();
            await client.query(`UPDATE vip_numbers SET status='reserved', updated_at=now() WHERE id=$1`, [vipNumberId]);
            await client.query(
              `INSERT INTO vip_number_orders (
                 id, vip_number_id, customer_id, company_id, phone_number, category, price,
                 customer_full_name, payment_method, sender_phone
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                orderId,
                vipNumberId,
                req.auth!.sub,
                vipNumber.company_id,
                vipNumber.phone_number,
                vipNumber.category,
                vipNumber.price,
                String(customerFullName).trim(),
                method.method,
                senderPhone,
              ]
            );
            await client.query(`INSERT INTO vip_number_order_status_history (order_id, status) VALUES ($1,'pending')`, [orderId]);
            return { orderId, duplicate: false };
          });

      const order = await queryOne<{ price: string }>(`SELECT ${VIP_ORDER_COLUMNS} FROM vip_number_orders WHERE id=$1`, [result.orderId]);
      const dialUssd = method.ussd_template.replace("{amount}", formatUssdAmount(Number(order!.price)));
      sendJson(res, result.duplicate ? 200 : 201, { ...order, dialUssd });
    } catch (err: any) {
      if (err?.status) return sendJson(res, err.status, { error: err.message });
      throw err;
    }
  }
);

vipNumbersRouter.get("/vip-numbers/orders", requireAuth("customer"), async (req, res) => {
  const orders = await query(`SELECT ${VIP_ORDER_COLUMNS} FROM vip_number_orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.auth!.sub]);
  sendJson(res, 200, orders);
});

vipNumbersRouter.get("/vip-numbers/orders/:id", requireAuth("customer"), async (req, res) => {
  const order = await queryOne(`SELECT ${VIP_ORDER_COLUMNS} FROM vip_number_orders WHERE id=$1 AND customer_id=$2`, [req.params.id, req.auth!.sub]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, { ...order, statusHistory: await loadOrderStatusHistory(order.id as string) });
});

vipNumbersRouter.post("/vip-numbers/orders/:id/cancel", requireAuth("customer"), async (req, res) => {
  const order = await queryOne<{ status: string; vip_number_id: string }>(
    `SELECT status, vip_number_id FROM vip_number_orders WHERE id=$1 AND customer_id=$2`,
    [req.params.id, req.auth!.sub]
  );
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  if (!["pending", "processing"].includes(order.status)) {
    return sendJson(res, 409, { error: "This order can no longer be cancelled" });
  }
  await restoreVipNumberAvailability(order.vip_number_id);
  await query(`UPDATE vip_number_orders SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1`, [req.params.id]);
  await query(`INSERT INTO vip_number_order_status_history (order_id, status, note) VALUES ($1,'cancelled','Cancelled by customer')`, [req.params.id]);
  await recordActivity({
    adminId: undefined,
    action: "vip_number_order_cancelled_by_customer",
    entityType: "vip_number_order",
    entityId: req.params.id,
    oldValue: { status: order.status },
    newValue: { status: "cancelled" },
  });
  sendJson(res, 200, await queryOne(`SELECT ${VIP_ORDER_COLUMNS} FROM vip_number_orders WHERE id=$1`, [req.params.id]));
});

// Re-issues the dial string for an order that failed/timed out at the
// phone's own dialer — never creates a second order or touches the
// reservation (already made once, at creation time). Recomputes from the
// payment method's current ussd_template rather than trusting anything
// cached, same reasoning as shop.routes.ts's identical route.
vipNumbersRouter.post("/vip-numbers/orders/:id/retry-payment", requireAuth("customer"), async (req, res) => {
  const order = await queryOne<{ status: string; payment_status: string; payment_method: string; price: string }>(
    `SELECT status, payment_status, payment_method, price FROM vip_number_orders WHERE id=$1 AND customer_id=$2`,
    [req.params.id, req.auth!.sub]
  );
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  if (order.payment_status === "paid") return sendJson(res, 409, { error: "This order has already been paid" });
  if (!["pending", "processing"].includes(order.status)) {
    return sendJson(res, 409, { error: "This order can no longer be retried — please contact support" });
  }
  const method = await queryOne<{ ussd_template: string }>(`SELECT ussd_template FROM shop_payment_methods WHERE method=$1`, [order.payment_method]);
  if (!method) return sendJson(res, 409, { error: "The payment method on this order is no longer available — please contact support" });
  const dialUssd = method.ussd_template.replace("{amount}", formatUssdAmount(Number(order.price)));
  sendJson(res, 200, { dialUssd });
});

// ==================== Admin: inventory ====================

vipNumbersRouter.get("/admin/vip-numbers", requirePermission("vipNumbers.manage"), async (req, res) => {
  const { companyId, status } = req.query as { companyId?: string; status?: string };
  const args: unknown[] = [];
  // packageId (via the LEFT JOIN below): null unless this number has been
  // placed into a Package (vipNumberPackages.routes.ts, migration 088) --
  // lets the Admin Dashboard's package-builder grey out/exclude a number
  // that's already claimed by another package, without a second request.
  let sql = `SELECT vn.id, vn.company_id, c.name AS company_name, vn.phone_number, vn.category, vn.price, vn.status, vn.created_at, vn.updated_at, pi.package_id
             FROM vip_numbers vn
             JOIN companies c ON c.id = vn.company_id
             LEFT JOIN vip_number_package_items pi ON pi.vip_number_id = vn.id
             WHERE 1=1`;
  if (companyId) {
    args.push(companyId);
    sql += ` AND vn.company_id=$${args.length}`;
  }
  if (status) {
    args.push(status);
    sql += ` AND vn.status=$${args.length}`;
  }
  sql += ` ORDER BY c.name, vn.category, vn.price DESC LIMIT 500`;
  sendJson(res, 200, await query(sql, args));
});

vipNumbersRouter.post("/admin/vip-numbers", requirePermission("vipNumbers.manage"), async (req, res) => {
  const { companyId, phoneNumber, category, price } = req.body ?? {};
  if (!companyId || !phoneNumber || !["gold", "silver"].includes(category) || price == null) {
    return sendJson(res, 400, { error: "companyId, phoneNumber, category ('gold'|'silver'), and price are required" });
  }
  const company = await queryOne(`SELECT id FROM companies WHERE id=$1`, [companyId]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });
  try {
    const row = await queryOne(
      `INSERT INTO vip_numbers (company_id, phone_number, category, price) VALUES ($1,$2,$3,$4) RETURNING *`,
      [companyId, String(phoneNumber).trim(), category, price]
    );
    await recordActivity({
      adminId: req.auth!.sub,
      action: "vip_number_added",
      entityType: "vip_number",
      entityId: (row as { id: string }).id,
      oldValue: null,
      newValue: row,
    });
    sendJson(res, 201, row);
  } catch (err: any) {
    if (err?.code === "23505") return sendJson(res, 409, { error: "This number already exists for this company" });
    throw err;
  }
});

vipNumbersRouter.put("/admin/vip-numbers/:id", requirePermission("vipNumbers.manage"), async (req, res) => {
  const existing = await queryOne<{ category: string; price: string }>(`SELECT category, price FROM vip_numbers WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "VIP number not found" });
  const category = ["gold", "silver"].includes(req.body?.category) ? req.body.category : existing.category;
  const price = req.body?.price != null ? req.body.price : existing.price;
  await query(`UPDATE vip_numbers SET category=$1, price=$2, updated_at=now() WHERE id=$3`, [category, price, req.params.id]);
  sendJson(res, 200, await queryOne(`SELECT * FROM vip_numbers WHERE id=$1`, [req.params.id]));
});

// Only while still 'available' — once reserved/sold, an order already
// depends on this row (vip_number_orders.vip_number_id has no ON DELETE
// CASCADE, deliberately, so a sold number's order history is never
// silently lost).
vipNumbersRouter.delete("/admin/vip-numbers/:id", requirePermission("vipNumbers.manage"), async (req, res) => {
  const result = await query(`DELETE FROM vip_numbers WHERE id=$1 AND status='available' RETURNING id`, [req.params.id]);
  if (result.length === 0) {
    const existing = await queryOne(`SELECT status FROM vip_numbers WHERE id=$1`, [req.params.id]);
    if (!existing) return sendJson(res, 404, { error: "VIP number not found" });
    return sendJson(res, 409, { error: "This number is reserved or sold and can no longer be deleted" });
  }
  sendJson(res, 200, { deleted: true });
});

// ==================== Admin: orders ====================

vipNumbersRouter.get("/admin/vip-numbers/orders", requirePermission("vipNumbers.manage"), async (req, res) => {
  const { status, search } = req.query as { status?: string; search?: string };
  const args: unknown[] = [];
  let sql = `SELECT o.${VIP_ORDER_COLUMNS.replace(/, /g, ", o.")}, c.name AS customer_name, c.phone AS customer_phone, comp.name AS company_name
             FROM vip_number_orders o
             JOIN customers c ON c.id = o.customer_id
             JOIN companies comp ON comp.id = o.company_id
             WHERE 1=1`;
  if (status && VIP_ORDER_STATUSES.includes(status)) {
    args.push(status);
    sql += ` AND o.status=$${args.length}`;
  }
  if (search) {
    args.push(`%${search}%`);
    sql += ` AND (o.id ILIKE $${args.length} OR o.customer_full_name ILIKE $${args.length} OR o.phone_number ILIKE $${args.length} OR c.phone ILIKE $${args.length})`;
  }
  sql += ` ORDER BY o.created_at DESC LIMIT 200`;
  sendJson(res, 200, await query(sql, args));
});

vipNumbersRouter.get("/admin/vip-numbers/orders/:id", requirePermission("vipNumbers.manage"), async (req, res) => {
  const order = await queryOne(
    `SELECT o.${VIP_ORDER_COLUMNS.replace(/, /g, ", o.")}, c.name AS customer_name, c.phone AS customer_phone, comp.name AS company_name
     FROM vip_number_orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN companies comp ON comp.id = o.company_id
     WHERE o.id=$1`,
    [req.params.id]
  );
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, { ...order, statusHistory: await loadOrderStatusHistory(req.params.id) });
});

// Manual payment confirmation — mirrors Shop's identical
// /admin/shop/orders/:id/payment-status route (Admin sees the collection
// number receive the money and taps this once confirmed). Moves the VIP
// number itself to 'sold' here — reservation already made it unavailable
// to anyone else the instant the order was created, but 'sold' is the
// permanent record that this number was actually paid for and delivered.
vipNumbersRouter.put("/admin/vip-numbers/orders/:id/payment-status", requirePermission("vipNumbers.manage"), async (req, res) => {
  const existing = await queryOne<{ status: string; payment_status: string; customer_id: string; vip_number_id: string }>(
    `SELECT status, payment_status, customer_id, vip_number_id FROM vip_number_orders WHERE id=$1`,
    [req.params.id]
  );
  if (!existing) return sendJson(res, 404, { error: "Order not found" });
  if (existing.payment_status === "paid") return sendJson(res, 409, { error: "This order is already marked paid" });
  if (TERMINAL_VIP_ORDER_STATUSES.includes(existing.status)) {
    return sendJson(res, 409, { error: `This order is already ${existing.status} and can no longer be marked paid` });
  }

  await query(
    `UPDATE vip_number_orders SET payment_status='paid', paid_at=now(),
       status = CASE WHEN status='pending' THEN 'processing' ELSE status END,
       verified_by_admin_id=$1, updated_at=now() WHERE id=$2`,
    [req.auth!.sub, req.params.id]
  );
  await query(`UPDATE vip_numbers SET status='sold', updated_at=now() WHERE id=$1`, [existing.vip_number_id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "vip_number_order_payment_confirmed",
    entityType: "vip_number_order",
    entityId: req.params.id,
    oldValue: { paymentStatus: existing.payment_status },
    newValue: { paymentStatus: "paid" },
  });
  if (existing.status === "pending") {
    await query(`INSERT INTO vip_number_order_status_history (order_id, status, note) VALUES ($1,'processing','Payment confirmed')`, [req.params.id]);
  }
  await notifyCustomer(
    existing.customer_id,
    "vip_number_order_update",
    "Payment Confirmed",
    `Your payment for VIP number order ${req.params.id} has been confirmed. We're processing your number now.`
  );
  sendJson(res, 200, await queryOne(`SELECT ${VIP_ORDER_COLUMNS} FROM vip_number_orders WHERE id=$1`, [req.params.id]));
});

// General status transitions (processing -> completed, or
// cancelled/failed from any non-terminal status) — same "reverse the
// reservation on cancel/fail, never mutate history" principle as Shop's
// identical route.
vipNumbersRouter.put("/admin/vip-numbers/orders/:id/status", requirePermission("vipNumbers.manage"), async (req, res) => {
  const { status, note } = req.body ?? {};
  if (!VIP_ORDER_STATUSES.includes(status)) return sendJson(res, 400, { error: `status must be one of ${VIP_ORDER_STATUSES.join(", ")}` });
  const existing = await queryOne<{ status: string; payment_status: string; customer_id: string; vip_number_id: string }>(
    `SELECT status, payment_status, customer_id, vip_number_id FROM vip_number_orders WHERE id=$1`,
    [req.params.id]
  );
  if (!existing) return sendJson(res, 404, { error: "Order not found" });
  if (TERMINAL_VIP_ORDER_STATUSES.includes(existing.status)) {
    return sendJson(res, 409, { error: `This order is already ${existing.status} and cannot be changed further` });
  }
  if (status === "completed" && existing.payment_status !== "paid") {
    return sendJson(res, 409, { error: "Mark payment as paid before completing this order" });
  }

  if (AVAILABILITY_RESTORING_STATUSES.includes(status)) {
    await restoreVipNumberAvailability(existing.vip_number_id);
  }

  await query(
    `UPDATE vip_number_orders SET status=$1,
       completed_at = CASE WHEN $1='completed' THEN now() ELSE completed_at END,
       cancelled_at = CASE WHEN $1 IN ('cancelled','failed') THEN now() ELSE cancelled_at END,
       updated_at=now()
     WHERE id=$2`,
    [status, req.params.id]
  );
  await query(`INSERT INTO vip_number_order_status_history (order_id, status, note) VALUES ($1,$2,$3)`, [
    req.params.id,
    status,
    typeof note === "string" ? note.trim() || null : null,
  ]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "vip_number_order_status_changed",
    entityType: "vip_number_order",
    entityId: req.params.id,
    oldValue: { status: existing.status },
    newValue: { status },
  });
  const notification =
    status === "completed"
      ? { title: "VIP Number Ready", body: `Your VIP number order ${req.params.id} has been completed.` }
      : status === "cancelled" || status === "failed"
        ? { title: "VIP Number Order Cancelled", body: `Your VIP number order ${req.params.id} was cancelled.` }
        : null;
  if (notification) {
    await notifyCustomer(existing.customer_id, "vip_number_order_update", notification.title, notification.body);
  }
  sendJson(res, 200, await queryOne(`SELECT ${VIP_ORDER_COLUMNS} FROM vip_number_orders WHERE id=$1`, [req.params.id]));
});
