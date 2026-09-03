import { Router } from "express";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { rateLimit } from "../auth/rateLimit.js";
import { sendJson } from "../utils/camelCase.js";
import { notifyCustomer } from "../services/customerNotify.js";
import { sendPushToAllAgents } from "../services/push.js";
import { recordActivity } from "../utils/activityLog.js";
import { formatEvcDahabUssdAmount } from "../utils/ussdFormatting.js";
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

// 'expired' (migration 090): a pending order whose customer never paid
// within RESERVATION_WINDOW_MINUTES -- distinct from a customer's own
// 'cancelled' and an admin's own 'failed', so Orders/order history can
// tell the three apart. Reached only through expireVipNumberOrderIfStale()
// below, never through the general PUT .../status route (not a status an
// admin picks by hand).
const VIP_ORDER_STATUSES = ["pending", "processing", "completed", "cancelled", "failed", "expired"];
const TERMINAL_VIP_ORDER_STATUSES = ["completed", "cancelled", "failed", "expired"];
const AVAILABILITY_RESTORING_STATUSES = ["cancelled", "failed", "expired"];

// A 'pending' order reserves its VIP number indefinitely otherwise (see
// restoreVipNumberAvailability's own call sites) -- 15 minutes matches the
// spec's own example window and is generous next to EVC Plus/eDahab's own
// Dial-to-Pay flow, which the customer is expected to complete within
// seconds of tapping Pay.
const RESERVATION_WINDOW_MINUTES = 15;

type VipNumberSettingsRow = {
  working_days: number[];
  opening_time: string;
  closing_time: string;
  manual_override: "open" | "closed" | null;
};

export async function loadVipNumberSettings(): Promise<VipNumberSettingsRow> {
  return (await queryOne<VipNumberSettingsRow>(`SELECT * FROM vip_number_settings WHERE id=true`))!;
}

// Identical shape/logic to shop.routes.ts's own resolveShopOpen (migration
// 078) -- now()/CURRENT_TIME are evaluated in the session's own time zone,
// which pool.ts already pins to Africa/Mogadishu for every connection, so
// this needs no timezone math of its own. EXTRACT(DOW ...) returns
// 0=Sunday..6=Saturday, matching workingDays' own convention. Governs both
// the individual ("1 Number") and Package purchase flows -- there is only
// one open/closed switch for VIP Numbers as a whole (see migration 090's
// own comment on vip_number_settings).
export async function resolveVipNumbersOpen(settings: VipNumberSettingsRow): Promise<boolean> {
  if (settings.manual_override) return settings.manual_override === "open";
  const now = await queryOne<{ dow: number; t: string }>(`SELECT EXTRACT(DOW FROM now())::int AS dow, now()::time AS t`);
  if (!now) return true;
  if (!settings.working_days.includes(now.dow)) return false;
  return now.t >= settings.opening_time && now.t <= settings.closing_time;
}

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
  "id, vip_number_id, customer_id, company_id, phone_number, category, price, customer_full_name, payment_method, sender_phone, location, district, mother_name, payment_status, status, paid_at, completed_at, cancelled_at, created_at, updated_at";

// Expires exactly one order if it's still 'pending' and has aged past
// RESERVATION_WINDOW_MINUTES -- locked (FOR UPDATE) so this can never race
// an admin confirming payment on the same order at the same moment: only
// one of "mark paid" (the payment-status route below, also FOR UPDATE) and
// "expire" wins, whichever's transaction commits first, and the loser's
// own terminal-status guard rejects cleanly rather than corrupting state.
// Shared by the periodic sweep below and the inline check on a
// just-found "you already have a pending order for this number" duplicate
// in POST /vip-numbers/orders, so both paths use the exact same logic and
// never disagree about what counts as stale.
export async function expireVipNumberOrderIfStale(orderId: string): Promise<boolean> {
  const expired = await withTransaction(async (client) => {
    const row = await client.query(
      `SELECT vip_number_id, status, created_at, customer_id FROM vip_number_orders WHERE id=$1 FOR UPDATE`,
      [orderId]
    );
    const order = row.rows[0];
    if (!order || order.status !== "pending") return null;
    if (new Date(order.created_at).getTime() > Date.now() - RESERVATION_WINDOW_MINUTES * 60 * 1000) return null;
    await client.query(`UPDATE vip_numbers SET status='available', updated_at=now() WHERE id=$1 AND status != 'sold'`, [order.vip_number_id]);
    await client.query(`UPDATE vip_number_orders SET status='expired', cancelled_at=now(), updated_at=now() WHERE id=$1`, [orderId]);
    await client.query(
      `INSERT INTO vip_number_order_status_history (order_id, status, note) VALUES ($1,'expired','Payment was not received within 15 minutes — reservation released')`,
      [orderId]
    );
    return { customerId: order.customer_id as string };
  });
  if (!expired) return false;
  await recordActivity({
    adminId: undefined,
    action: "vip_number_order_expired",
    entityType: "vip_number_order",
    entityId: orderId,
    oldValue: { status: "pending" },
    newValue: { status: "expired" },
  });
  await notifyCustomer(
    expired.customerId,
    "vip_number_order_update",
    "Reservation Expired",
    `Your VIP number order ${orderId} expired because payment wasn't received in time. The number has been released.`
  );
  return true;
}

// Self-starting on module load, same module-level setInterval pattern as
// support.routes.ts's own 1-hour queue-timeout sweep (ES module imports
// are cached, so this only ever starts once even if this file is imported
// more than once). Finds every pending order old enough to expire and
// closes each one out through the exact same expireVipNumberOrderIfStale()
// the inline dup-order check above also calls.
const RESERVATION_EXPIRY_SWEEP_MS = 60_000;
setInterval(async () => {
  try {
    const stale = await query<{ id: string }>(
      `SELECT id FROM vip_number_orders WHERE status='pending' AND created_at < now() - make_interval(mins => $1)`,
      [RESERVATION_WINDOW_MINUTES]
    );
    for (const row of stale) {
      await expireVipNumberOrderIfStale(row.id);
    }
  } catch (err) {
    console.error("VIP number reservation expiry sweep failed:", (err as Error).message);
  }
}, RESERVATION_EXPIRY_SWEEP_MS);

// ==================== Working hours / open-close (mirrors shop.routes.ts) ====================

// Public -- the Customer App needs this to show the 🟢/🔴 badge and to
// block Purchase/Pay before even attempting an order while closed.
vipNumbersRouter.get("/vip-numbers/settings", async (_req, res) => {
  const settings = await loadVipNumberSettings();
  sendJson(res, 200, {
    isOpen: await resolveVipNumbersOpen(settings),
    workingDays: settings.working_days,
    openingTime: settings.opening_time,
    closingTime: settings.closing_time,
    manualOverride: settings.manual_override,
  });
});

vipNumbersRouter.get("/admin/vip-numbers/settings", requirePermission("vipNumbers.manage"), async (_req, res) => {
  const settings = await loadVipNumberSettings();
  sendJson(res, 200, { ...settings, isOpen: await resolveVipNumbersOpen(settings) });
});

const VIP_VALID_DOW = new Set([0, 1, 2, 3, 4, 5, 6]);
const VIP_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

vipNumbersRouter.put("/admin/vip-numbers/settings", requirePermission("vipNumbers.manage"), async (req, res) => {
  const { workingDays, openingTime, closingTime, manualOverride } = req.body ?? {};
  if (workingDays !== undefined) {
    if (!Array.isArray(workingDays) || workingDays.length === 0 || !workingDays.every((d: unknown) => VIP_VALID_DOW.has(Number(d)))) {
      return sendJson(res, 400, { error: "workingDays must be a non-empty array of integers 0-6 (0=Sunday)" });
    }
  }
  if (openingTime !== undefined && !VIP_TIME_RE.test(openingTime)) {
    return sendJson(res, 400, { error: "openingTime must be in HH:MM (24-hour) form" });
  }
  if (closingTime !== undefined && !VIP_TIME_RE.test(closingTime)) {
    return sendJson(res, 400, { error: "closingTime must be in HH:MM (24-hour) form" });
  }
  if (manualOverride !== undefined && manualOverride !== null && !["open", "closed"].includes(manualOverride)) {
    return sendJson(res, 400, { error: "manualOverride must be 'open', 'closed', or null" });
  }
  const existing = await loadVipNumberSettings();
  await query(
    `UPDATE vip_number_settings SET
       working_days=$1, opening_time=$2, closing_time=$3, manual_override=$4,
       updated_at=now(), updated_by=$5
     WHERE id=true`,
    [
      workingDays !== undefined ? workingDays.map(Number) : existing.working_days,
      openingTime ?? existing.opening_time,
      closingTime ?? existing.closing_time,
      manualOverride !== undefined ? manualOverride : existing.manual_override,
      req.auth!.sub,
    ]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "vip_number_settings_updated",
    entityType: "vip_number_settings",
    entityId: "vip_number_settings",
    oldValue: existing,
    newValue: { workingDays, openingTime, closingTime, manualOverride },
  });
  const settings = await loadVipNumberSettings();
  sendJson(res, 200, { ...settings, isOpen: await resolveVipNumbersOpen(settings) });
});

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
    const { vipNumberId, paymentMethod, senderPhone, customerFullName, location, district, motherName } = req.body ?? {};
    if (!vipNumberId) return sendJson(res, 400, { error: "vipNumberId is required" });
    if (!senderPhone) return sendJson(res, 400, { error: "Provide the phone number you'll pay from" });
    if (typeof customerFullName !== "string" || !hasThreeNames(customerFullName)) {
      return sendJson(res, 400, { error: "Enter your full name (first, father's, and grandfather's name)" });
    }
    // Collected on the checkout flow's own Customer Information step
    // (screen 1 of 2), required for DALAB's real-world number
    // registration/porting after payment -- same requiredness rule as
    // customerFullName above, just three more fields.
    if (typeof location !== "string" || !location.trim()) {
      return sendJson(res, 400, { error: "Enter where you live" });
    }
    if (typeof district !== "string" || !district.trim()) {
      return sendJson(res, 400, { error: "Enter your district" });
    }
    if (typeof motherName !== "string" || !motherName.trim()) {
      return sendJson(res, 400, { error: "Enter your mother's name" });
    }

    // Enforced here too, not just hidden in the Customer App UI -- matches
    // how shop.routes.ts's own closed-shop gate works at order creation.
    const vipSettings = await loadVipNumberSettings();
    if (!(await resolveVipNumbersOpen(vipSettings))) {
      return sendJson(res, 409, { error: "VIP Number sales are currently closed. Please check back during our working hours." });
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
    // second reservation of an already-reserved number -- unless that
    // order has actually aged past the reservation window, in which case
    // it's expired in place first (releasing the number) so this request
    // falls through to reserve it fresh instead of handing back a dead
    // order the customer can no longer pay.
    let dup = await queryOne<{ id: string }>(
      `SELECT id FROM vip_number_orders WHERE customer_id=$1 AND vip_number_id=$2 AND status='pending' LIMIT 1`,
      [req.auth!.sub, vipNumberId]
    );
    if (dup && (await expireVipNumberOrderIfStale(dup.id))) {
      dup = null;
    }

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
                 customer_full_name, payment_method, sender_phone, location, district, mother_name
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
                String(location).trim(),
                String(district).trim(),
                String(motherName).trim(),
              ]
            );
            await client.query(`INSERT INTO vip_number_order_status_history (order_id, status) VALUES ($1,'pending')`, [orderId]);
            return { orderId, duplicate: false };
          });

      const order = await queryOne<{ price: string }>(`SELECT ${VIP_ORDER_COLUMNS} FROM vip_number_orders WHERE id=$1`, [result.orderId]);
      const dialUssd = method.ussd_template.replace("{amount}", formatEvcDahabUssdAmount(Number(order!.price)));
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
  const dialUssd = method.ussd_template.replace("{amount}", formatEvcDahabUssdAmount(Number(order.price)));
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

// ==================== Agent: orders (read + Complete Order) ====================

// The Agent App's own Orders tab -- same VIP_ORDER_COLUMNS/filters/joins as
// the Admin Dashboard's identical routes above, just under agent auth.
vipNumbersRouter.get("/agent/vip-numbers/orders", requireAuth("agent"), async (req, res) => {
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

vipNumbersRouter.get("/agent/vip-numbers/orders/:id", requireAuth("agent"), async (req, res) => {
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

// The Agent App's "Complete Order" action -- same locking/guards as the
// admin PUT .../status route's own "completed" branch (payment must
// already be confirmed, order must not already be terminal), hardcoded to
// 'completed' rather than accepting an arbitrary status: an agent can only
// ever complete a paid order here, never cancel/fail one (that stays an
// admin-only action via the existing PUT .../status route above).
// recordActivity's adminId is left undefined -- admin_activity_log.admin_id
// is FK'd to admin_users, not agents, so an agent's own id would violate
// that constraint (same reasoning orders.routes.ts's completeOrderById
// already follows for its own agent-triggered completions).
vipNumbersRouter.post("/agent/vip-numbers/orders/:id/complete", requireAuth("agent"), async (req, res) => {
  let existing: { status: string; payment_status: string; customer_id: string; vip_number_id: string };
  try {
    existing = await withTransaction(async (client) => {
      const row = await client.query(
        `SELECT status, payment_status, customer_id, vip_number_id FROM vip_number_orders WHERE id=$1 FOR UPDATE`,
        [req.params.id]
      );
      const order = row.rows[0];
      if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
      if (TERMINAL_VIP_ORDER_STATUSES.includes(order.status)) {
        throw Object.assign(new Error(`This order is already ${order.status} and cannot be changed further`), { status: 409 });
      }
      if (order.payment_status !== "paid") {
        throw Object.assign(new Error("This order cannot be completed until payment is confirmed"), { status: 409 });
      }
      await client.query(
        `UPDATE vip_number_orders SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1`,
        [req.params.id]
      );
      return order;
    });
  } catch (err: any) {
    if (err?.status) return sendJson(res, err.status, { error: err.message });
    throw err;
  }
  await query(`INSERT INTO vip_number_order_status_history (order_id, status, note) VALUES ($1,'completed','Completed by agent')`, [
    req.params.id,
  ]);
  await recordActivity({
    adminId: undefined,
    action: "vip_number_order_completed_by_agent",
    entityType: "vip_number_order",
    entityId: req.params.id,
    oldValue: { status: existing.status },
    newValue: { status: "completed" },
  });
  await notifyCustomer(existing.customer_id, "vip_number_order_update", "VIP Number Ready", `Your VIP number order ${req.params.id} has been completed.`);
  sendJson(res, 200, await queryOne(`SELECT ${VIP_ORDER_COLUMNS} FROM vip_number_orders WHERE id=$1`, [req.params.id]));
});

// Manual payment confirmation — mirrors Shop's identical
// /admin/shop/orders/:id/payment-status route (Admin sees the collection
// number receive the money and taps this once confirmed). Moves the VIP
// number itself to 'sold' here — reservation already made it unavailable
// to anyone else the instant the order was created, but 'sold' is the
// permanent record that this number was actually paid for and delivered.
vipNumbersRouter.put("/admin/vip-numbers/orders/:id/payment-status", requirePermission("vipNumbers.manage"), async (req, res) => {
  // Locked (FOR UPDATE) and transactional so this can never race the
  // expiry sweep confirming/expiring the same order at the same moment --
  // see expireVipNumberOrderIfStale's own comment.
  let existing: { status: string; payment_status: string; customer_id: string; vip_number_id: string };
  try {
    existing = await withTransaction(async (client) => {
      const row = await client.query(
        `SELECT status, payment_status, customer_id, vip_number_id FROM vip_number_orders WHERE id=$1 FOR UPDATE`,
        [req.params.id]
      );
      const order = row.rows[0];
      if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
      if (order.payment_status === "paid") throw Object.assign(new Error("This order is already marked paid"), { status: 409 });
      if (TERMINAL_VIP_ORDER_STATUSES.includes(order.status)) {
        throw Object.assign(new Error(`This order is already ${order.status} and can no longer be marked paid`), { status: 409 });
      }
      await client.query(
        `UPDATE vip_number_orders SET payment_status='paid', paid_at=now(),
           status = CASE WHEN status='pending' THEN 'processing' ELSE status END,
           verified_by_admin_id=$1, updated_at=now() WHERE id=$2`,
        [req.auth!.sub, req.params.id]
      );
      await client.query(`UPDATE vip_numbers SET status='sold', updated_at=now() WHERE id=$1`, [order.vip_number_id]);
      return order;
    });
  } catch (err: any) {
    if (err?.status) return sendJson(res, err.status, { error: err.message });
    throw err;
  }
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
  // Real, push-only signal to every agent device -- see
  // sendPushToAllAgents's own comment on why this is a broadcast rather
  // than a targeted per-order recipient.
  await sendPushToAllAgents({
    title: "⭐ VIP Number Order Paid",
    body: `Order ${req.params.id} payment confirmed.`,
    data: { screen: "agent_orders", orderType: "vip_number", orderId: req.params.id },
  });
  sendJson(res, 200, await queryOne(`SELECT ${VIP_ORDER_COLUMNS} FROM vip_number_orders WHERE id=$1`, [req.params.id]));
});

// General status transitions (processing -> completed, or
// cancelled/failed from any non-terminal status) — same "reverse the
// reservation on cancel/fail, never mutate history" principle as Shop's
// identical route.
vipNumbersRouter.put("/admin/vip-numbers/orders/:id/status", requirePermission("vipNumbers.manage"), async (req, res) => {
  const { status, note } = req.body ?? {};
  if (!VIP_ORDER_STATUSES.includes(status) || status === "expired") {
    return sendJson(res, 400, { error: `status must be one of pending, processing, completed, cancelled, failed` });
  }
  // Locked (FOR UPDATE) and transactional -- same TOCTOU protection as the
  // payment-status route above, against the expiry sweep changing this
  // exact order underneath an in-flight admin request.
  let existing: { status: string; payment_status: string; customer_id: string; vip_number_id: string };
  try {
    existing = await withTransaction(async (client) => {
      const row = await client.query(
        `SELECT status, payment_status, customer_id, vip_number_id FROM vip_number_orders WHERE id=$1 FOR UPDATE`,
        [req.params.id]
      );
      const order = row.rows[0];
      if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
      if (TERMINAL_VIP_ORDER_STATUSES.includes(order.status)) {
        throw Object.assign(new Error(`This order is already ${order.status} and cannot be changed further`), { status: 409 });
      }
      if (status === "completed" && order.payment_status !== "paid") {
        throw Object.assign(new Error("Mark payment as paid before completing this order"), { status: 409 });
      }
      if (AVAILABILITY_RESTORING_STATUSES.includes(status)) {
        await client.query(`UPDATE vip_numbers SET status='available', updated_at=now() WHERE id=$1 AND status != 'sold'`, [order.vip_number_id]);
      }
      await client.query(
        `UPDATE vip_number_orders SET status=$1,
           completed_at = CASE WHEN $1='completed' THEN now() ELSE completed_at END,
           cancelled_at = CASE WHEN $1 IN ('cancelled','failed') THEN now() ELSE cancelled_at END,
           updated_at=now()
         WHERE id=$2`,
        [status, req.params.id]
      );
      return order;
    });
  } catch (err: any) {
    if (err?.status) return sendJson(res, err.status, { error: err.message });
    throw err;
  }
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
