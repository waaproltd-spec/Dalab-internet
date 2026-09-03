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

// VIP Number Packages: a 2/3/4-number bundle of individual VIP numbers
// (see vipNumbers.routes.ts / migration 087) an admin curates and prices
// as one item, purchased in a single transaction/order instead of one
// order per number (migration 088). A parallel, independent purchase path
// -- the existing single-number catalog/checkout in vipNumbers.routes.ts
// is untouched by this file, except for one added filter on its own
// public GET /vip-numbers (see that route's own comment) so a number that
// has been placed into a package can no longer also be bought
// individually while it's a package member.
//
// Every /admin/vip-numbers/packages/* route below -- including plain
// GETs -- requires the same "vipNumbers.manage" permission the
// individual-number admin routes already use; there's no separate
// package-specific permission.
export const vipNumberPackagesRouter = Router();

const PACKAGE_SIZES = [2, 3, 4];
const PACKAGE_ORDER_STATUSES = ["pending", "processing", "completed", "cancelled", "failed"];
const TERMINAL_PACKAGE_ORDER_STATUSES = ["completed", "cancelled", "failed"];
const AVAILABILITY_RESTORING_STATUSES = ["cancelled", "failed"];

function generatePackageOrderId(): string {
  return "VPK" + Math.floor(100000000 + Math.random() * 900000000);
}

// Same "at least 3 words" full-name convention vipNumbers.routes.ts's
// identical helper enforces, for the same real-world number
// registration/porting reason.
function hasThreeNames(name: string): boolean {
  return name.trim().split(/\s+/).filter(Boolean).length >= 3;
}

async function loadPackageOrderStatusHistory(orderId: string) {
  return query(
    `SELECT status, note, changed_at FROM vip_number_package_order_status_history WHERE package_order_id=$1 ORDER BY changed_at ASC`,
    [orderId]
  );
}

async function loadPackageOrderItems(orderId: string) {
  return query(
    `SELECT poi.vip_number_id, poi.phone_number, poi.category, poi.company_id, c.name AS company_name
     FROM vip_number_package_order_items poi JOIN companies c ON c.id = poi.company_id
     WHERE poi.package_order_id=$1
     ORDER BY poi.phone_number`,
    [orderId]
  );
}

// Reverses the reservation made at package-order-creation time for every
// member number at once -- shared by the customer-initiated cancel route
// and the admin status route, same "reverse the reservation, never mutate
// history" principle restoreVipNumberAvailability (vipNumbers.routes.ts)
// already uses for a single number.
async function restorePackageNumbersAvailability(packageId: string) {
  await query(
    `UPDATE vip_numbers SET status='available', updated_at=now()
     WHERE id IN (SELECT vip_number_id FROM vip_number_package_items WHERE package_id=$1) AND status != 'sold'`,
    [packageId]
  );
}

const PACKAGE_ORDER_COLUMNS =
  "id, package_id, size, price, customer_id, customer_full_name, payment_method, sender_phone, payment_status, status, paid_at, completed_at, cancelled_at, created_at, updated_at";

async function loadPackageWithItems(packageId: string) {
  const pkg = await queryOne(
    `SELECT id, size, price, active, created_at, updated_at FROM vip_number_packages WHERE id=$1`,
    [packageId]
  );
  if (!pkg) return null;
  const items = await query(
    `SELECT pi.vip_number_id, pi.position, vn.phone_number, vn.category, vn.company_id, c.name AS company_name
     FROM vip_number_package_items pi
     JOIN vip_numbers vn ON vn.id = pi.vip_number_id
     JOIN companies c ON c.id = vn.company_id
     WHERE pi.package_id=$1 ORDER BY pi.position`,
    [packageId]
  );
  return { ...(pkg as object), numbers: items };
}

// Locks every candidate number and checks it's currently Available and not
// already a member of a DIFFERENT package -- shared by package creation
// and package membership edits so both enforce the exact same rules.
// `client` must already be inside a transaction (the caller's
// withTransaction) since this takes row locks. `excludePackageId` lets an
// edit re-select a number that's already a member of the package being
// edited (renaming a package's own members isn't "already in another
// package").
async function lockAndValidatePackageNumbers(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  vipNumberIds: string[],
  excludePackageId?: string
): Promise<void> {
  const rows = await client.query(
    `SELECT vn.id, vn.status, pi.package_id AS existing_package_id
     FROM vip_numbers vn
     LEFT JOIN vip_number_package_items pi ON pi.vip_number_id = vn.id
     WHERE vn.id = ANY($1)
     FOR UPDATE OF vn`,
    [vipNumberIds]
  );
  if (rows.rows.length !== vipNumberIds.length) {
    throw Object.assign(new Error("One or more selected numbers no longer exist"), { status: 404 });
  }
  for (const row of rows.rows) {
    if (row.status !== "available") {
      throw Object.assign(new Error("Every number in a package must currently be Available"), { status: 409 });
    }
    if (row.existing_package_id && row.existing_package_id !== excludePackageId) {
      throw Object.assign(new Error("One of these numbers already belongs to another package"), { status: 409 });
    }
  }
}

// ==================== Public catalog (no auth) ====================

// Active packages of a given size, each with its member numbers +
// companies -- the customer app's "2/3/4 Numbers" tabs call this with
// ?size=2|3|4 (the existing "1 Number" tab is untouched: it keeps calling
// GET /vip-numbers exactly as before, unaware packages exist at all).
vipNumberPackagesRouter.get("/vip-numbers/packages", async (req, res) => {
  const { size } = req.query as { size?: string };
  const args: unknown[] = [];
  let sql = `SELECT id, size, price, created_at FROM vip_number_packages WHERE active = true`;
  if (size) {
    args.push(Number(size));
    sql += ` AND size=$${args.length}`;
  }
  sql += ` ORDER BY size, price, created_at DESC LIMIT 200`;
  const packages = await query<{ id: string }>(sql, args);
  if (packages.length === 0) return sendJson(res, 200, []);

  const packageIds = packages.map((p) => p.id);
  const items = await query<{ package_id: string }>(
    `SELECT pi.package_id, vn.id AS vip_number_id, vn.phone_number, vn.category, vn.company_id, c.name AS company_name
     FROM vip_number_package_items pi
     JOIN vip_numbers vn ON vn.id = pi.vip_number_id
     JOIN companies c ON c.id = vn.company_id
     WHERE pi.package_id = ANY($1)
     ORDER BY pi.position, vn.phone_number`,
    [packageIds]
  );
  const itemsByPackage = new Map<string, unknown[]>();
  for (const item of items) {
    const list = itemsByPackage.get(item.package_id) ?? [];
    list.push(item);
    itemsByPackage.set(item.package_id, list);
  }
  sendJson(
    res,
    200,
    packages.map((p: any) => ({ ...p, numbers: itemsByPackage.get(p.id) ?? [] }))
  );
});

// ==================== Customer orders ====================

vipNumberPackagesRouter.post(
  "/vip-numbers/packages/orders",
  requireAuth("customer"),
  rateLimit("customer-vip-package-order-create", 20, 15 * 60 * 1000),
  async (req, res) => {
    const { packageId, paymentMethod, senderPhone, customerFullName } = req.body ?? {};
    if (!packageId) return sendJson(res, 400, { error: "packageId is required" });
    if (!senderPhone) return sendJson(res, 400, { error: "Provide the phone number you'll pay from" });
    if (typeof customerFullName !== "string" || !hasThreeNames(customerFullName)) {
      return sendJson(res, 400, { error: "Enter your full name (first, father's, and grandfather's name)" });
    }

    const method = await queryOne<{ method: string; ussd_template: string }>(
      `SELECT method, ussd_template FROM shop_payment_methods WHERE method=$1`,
      [paymentMethod]
    );
    if (!method) return sendJson(res, 400, { error: "Choose a valid payment method" });

    const senderCompanyKey = method.method === "evc" ? "evc_plus" : method.method;
    const senderCheck = validateMobileNumber(String(senderPhone), senderCompanyKey);
    if (!senderCheck.valid) return sendJson(res, 400, { error: senderCheck.error });

    // A double-tap of "Purchase Package" on the same still-pending order
    // returns the existing order rather than attempting (and failing) a
    // second reservation of an already-reserved package.
    const dup = await queryOne<{ id: string }>(
      `SELECT id FROM vip_number_package_orders WHERE customer_id=$1 AND package_id=$2 AND status='pending' LIMIT 1`,
      [req.auth!.sub, packageId]
    );

    try {
      const result = dup
        ? { orderId: dup.id, duplicate: true }
        : await withTransaction(async (client) => {
            const pkgRow = await client.query(`SELECT id, size, price, active FROM vip_number_packages WHERE id=$1 FOR UPDATE`, [
              packageId,
            ]);
            const pkg = pkgRow.rows[0];
            if (!pkg) throw Object.assign(new Error("Package not found"), { status: 404 });
            if (!pkg.active) throw Object.assign(new Error("This package is no longer available"), { status: 409 });

            // Lock every member number, in a stable order (by id) to avoid
            // deadlocking against another transaction locking the same
            // rows in a different order.
            const numbersRes = await client.query(
              `SELECT vn.id, vn.company_id, vn.phone_number, vn.category, vn.status
               FROM vip_numbers vn
               JOIN vip_number_package_items pi ON pi.vip_number_id = vn.id
               WHERE pi.package_id = $1
               ORDER BY vn.id
               FOR UPDATE OF vn`,
              [packageId]
            );
            const numbers = numbersRes.rows;
            if (numbers.length !== pkg.size) {
              throw Object.assign(new Error("This package's numbers changed — please refresh and try again"), { status: 409 });
            }
            const unavailable = numbers.find((n: any) => n.status !== "available");
            if (unavailable) {
              throw Object.assign(
                new Error("One of this package's numbers has just been taken — please refresh and try again"),
                { status: 409 }
              );
            }

            const orderId = generatePackageOrderId();
            await client.query(`UPDATE vip_numbers SET status='reserved', updated_at=now() WHERE id = ANY($1)`, [
              numbers.map((n: any) => n.id),
            ]);
            await client.query(
              `INSERT INTO vip_number_package_orders (
                 id, package_id, size, price, customer_id, customer_full_name, payment_method, sender_phone
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [orderId, packageId, pkg.size, pkg.price, req.auth!.sub, String(customerFullName).trim(), method.method, senderPhone]
            );
            for (const n of numbers) {
              await client.query(
                `INSERT INTO vip_number_package_order_items (package_order_id, vip_number_id, company_id, phone_number, category)
                 VALUES ($1,$2,$3,$4,$5)`,
                [orderId, n.id, n.company_id, n.phone_number, n.category]
              );
            }
            await client.query(
              `INSERT INTO vip_number_package_order_status_history (package_order_id, status) VALUES ($1,'pending')`,
              [orderId]
            );
            return { orderId, duplicate: false };
          });

      const order = await queryOne<{ price: string }>(
        `SELECT ${PACKAGE_ORDER_COLUMNS} FROM vip_number_package_orders WHERE id=$1`,
        [result.orderId]
      );
      const dialUssd = method.ussd_template.replace("{amount}", formatUssdAmount(Number(order!.price)));
      const items = await loadPackageOrderItems(result.orderId);
      sendJson(res, result.duplicate ? 200 : 201, { ...order, items, dialUssd });
    } catch (err: any) {
      if (err?.status) return sendJson(res, err.status, { error: err.message });
      throw err;
    }
  }
);

vipNumberPackagesRouter.get("/vip-numbers/packages/orders", requireAuth("customer"), async (req, res) => {
  const orders = await query(
    `SELECT ${PACKAGE_ORDER_COLUMNS} FROM vip_number_package_orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [req.auth!.sub]
  );
  sendJson(res, 200, orders);
});

vipNumberPackagesRouter.get("/vip-numbers/packages/orders/:id", requireAuth("customer"), async (req, res) => {
  const order = await queryOne(
    `SELECT ${PACKAGE_ORDER_COLUMNS} FROM vip_number_package_orders WHERE id=$1 AND customer_id=$2`,
    [req.params.id, req.auth!.sub]
  );
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  const items = await loadPackageOrderItems(req.params.id);
  const statusHistory = await loadPackageOrderStatusHistory(req.params.id);
  sendJson(res, 200, { ...order, items, statusHistory });
});

vipNumberPackagesRouter.post("/vip-numbers/packages/orders/:id/cancel", requireAuth("customer"), async (req, res) => {
  const order = await queryOne<{ status: string; package_id: string }>(
    `SELECT status, package_id FROM vip_number_package_orders WHERE id=$1 AND customer_id=$2`,
    [req.params.id, req.auth!.sub]
  );
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  if (!["pending", "processing"].includes(order.status)) {
    return sendJson(res, 409, { error: "This order can no longer be cancelled" });
  }
  await restorePackageNumbersAvailability(order.package_id);
  await query(`UPDATE vip_number_package_orders SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1`, [
    req.params.id,
  ]);
  await query(
    `INSERT INTO vip_number_package_order_status_history (package_order_id, status, note) VALUES ($1,'cancelled','Cancelled by customer')`,
    [req.params.id]
  );
  await recordActivity({
    adminId: undefined,
    action: "vip_number_package_order_cancelled_by_customer",
    entityType: "vip_number_package_order",
    entityId: req.params.id,
    oldValue: { status: order.status },
    newValue: { status: "cancelled" },
  });
  sendJson(res, 200, await queryOne(`SELECT ${PACKAGE_ORDER_COLUMNS} FROM vip_number_package_orders WHERE id=$1`, [req.params.id]));
});

// Re-issues the dial string for an order that failed/timed out at the
// phone's own dialer -- never creates a second order or touches the
// reservation, same reasoning as vipNumbers.routes.ts's identical route.
vipNumberPackagesRouter.post("/vip-numbers/packages/orders/:id/retry-payment", requireAuth("customer"), async (req, res) => {
  const order = await queryOne<{ status: string; payment_status: string; payment_method: string; price: string }>(
    `SELECT status, payment_status, payment_method, price FROM vip_number_package_orders WHERE id=$1 AND customer_id=$2`,
    [req.params.id, req.auth!.sub]
  );
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  if (order.payment_status === "paid") return sendJson(res, 409, { error: "This order has already been paid" });
  if (!["pending", "processing"].includes(order.status)) {
    return sendJson(res, 409, { error: "This order can no longer be retried — please contact support" });
  }
  const method = await queryOne<{ ussd_template: string }>(`SELECT ussd_template FROM shop_payment_methods WHERE method=$1`, [
    order.payment_method,
  ]);
  if (!method) return sendJson(res, 409, { error: "The payment method on this order is no longer available — please contact support" });
  const dialUssd = method.ussd_template.replace("{amount}", formatUssdAmount(Number(order.price)));
  sendJson(res, 200, { dialUssd });
});

// ==================== Admin: package inventory ====================

vipNumberPackagesRouter.get("/admin/vip-numbers/packages", requirePermission("vipNumbers.manage"), async (req, res) => {
  const { size, active } = req.query as { size?: string; active?: string };
  const args: unknown[] = [];
  let sql = `SELECT id FROM vip_number_packages WHERE 1=1`;
  if (size) {
    args.push(Number(size));
    sql += ` AND size=$${args.length}`;
  }
  if (active === "true" || active === "false") {
    args.push(active === "true");
    sql += ` AND active=$${args.length}`;
  }
  sql += ` ORDER BY created_at DESC LIMIT 500`;
  const rows = await query<{ id: string }>(sql, args);
  const packages = [];
  for (const row of rows) {
    packages.push(await loadPackageWithItems(row.id));
  }
  sendJson(res, 200, packages);
});

vipNumberPackagesRouter.post("/admin/vip-numbers/packages", requirePermission("vipNumbers.manage"), async (req, res) => {
  const { size, price, vipNumberIds } = req.body ?? {};
  if (!PACKAGE_SIZES.includes(Number(size))) {
    return sendJson(res, 400, { error: `size must be one of ${PACKAGE_SIZES.join(", ")}` });
  }
  if (price == null || Number(price) < 0) return sendJson(res, 400, { error: "price is required" });
  if (!Array.isArray(vipNumberIds) || vipNumberIds.length !== Number(size)) {
    return sendJson(res, 400, { error: `Select exactly ${size} VIP numbers for this package` });
  }
  if (new Set(vipNumberIds).size !== vipNumberIds.length) {
    return sendJson(res, 400, { error: "Each number can only be selected once" });
  }

  try {
    const packageId = await withTransaction(async (client) => {
      await lockAndValidatePackageNumbers(client, vipNumberIds);
      const created = await client.query(`INSERT INTO vip_number_packages (size, price) VALUES ($1,$2) RETURNING id`, [
        Number(size),
        Number(price),
      ]);
      const newId = created.rows[0].id as string;
      for (let i = 0; i < vipNumberIds.length; i++) {
        await client.query(`INSERT INTO vip_number_package_items (package_id, vip_number_id, position) VALUES ($1,$2,$3)`, [
          newId,
          vipNumberIds[i],
          i,
        ]);
      }
      return newId;
    });

    const full = await loadPackageWithItems(packageId);
    await recordActivity({
      adminId: req.auth!.sub,
      action: "vip_number_package_added",
      entityType: "vip_number_package",
      entityId: packageId,
      oldValue: null,
      newValue: full,
    });
    sendJson(res, 201, full);
  } catch (err: any) {
    if (err?.status) return sendJson(res, err.status, { error: err.message });
    throw err;
  }
});

vipNumberPackagesRouter.put("/admin/vip-numbers/packages/:id", requirePermission("vipNumbers.manage"), async (req, res) => {
  const existing = await queryOne<{ size: number }>(`SELECT size FROM vip_number_packages WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Package not found" });

  const { price, active, vipNumberIds } = req.body ?? {};

  try {
    if (Array.isArray(vipNumberIds)) {
      const hasOpenOrder = await queryOne(
        `SELECT id FROM vip_number_package_orders WHERE package_id=$1 AND status IN ('pending','processing')`,
        [req.params.id]
      );
      if (hasOpenOrder) {
        return sendJson(res, 409, { error: "This package has an order in progress — its numbers can't be changed right now" });
      }
      if (vipNumberIds.length !== existing.size) {
        return sendJson(res, 400, { error: `Select exactly ${existing.size} VIP numbers for this package` });
      }
      if (new Set(vipNumberIds).size !== vipNumberIds.length) {
        return sendJson(res, 400, { error: "Each number can only be selected once" });
      }
      await withTransaction(async (client) => {
        await lockAndValidatePackageNumbers(client, vipNumberIds, req.params.id);
        await client.query(`DELETE FROM vip_number_package_items WHERE package_id=$1`, [req.params.id]);
        for (let i = 0; i < vipNumberIds.length; i++) {
          await client.query(`INSERT INTO vip_number_package_items (package_id, vip_number_id, position) VALUES ($1,$2,$3)`, [
            req.params.id,
            vipNumberIds[i],
            i,
          ]);
        }
      });
    }

    const fields: string[] = [];
    const args: unknown[] = [];
    if (price != null) {
      args.push(Number(price));
      fields.push(`price=$${args.length}`);
    }
    if (typeof active === "boolean") {
      args.push(active);
      fields.push(`active=$${args.length}`);
    }
    if (fields.length > 0) {
      args.push(req.params.id);
      await query(`UPDATE vip_number_packages SET ${fields.join(", ")}, updated_at=now() WHERE id=$${args.length}`, args);
    }

    sendJson(res, 200, await loadPackageWithItems(req.params.id));
  } catch (err: any) {
    if (err?.status) return sendJson(res, err.status, { error: err.message });
    throw err;
  }
});

// Only while it has never had a non-cancelled/failed order -- same "only
// while available" rule vip_numbers' own DELETE route uses.
vipNumberPackagesRouter.delete("/admin/vip-numbers/packages/:id", requirePermission("vipNumbers.manage"), async (req, res) => {
  const openOrder = await queryOne(
    `SELECT id FROM vip_number_package_orders WHERE package_id=$1 AND status NOT IN ('cancelled','failed')`,
    [req.params.id]
  );
  if (openOrder) {
    return sendJson(res, 409, { error: "This package has an order that isn't cancelled/failed and can no longer be deleted" });
  }
  const result = await query(`DELETE FROM vip_number_packages WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Package not found" });
  sendJson(res, 200, { deleted: true });
});

// ==================== Admin: package orders ====================

vipNumberPackagesRouter.get("/admin/vip-numbers/packages/orders", requirePermission("vipNumbers.manage"), async (req, res) => {
  const { status, search } = req.query as { status?: string; search?: string };
  const args: unknown[] = [];
  let sql = `SELECT o.${PACKAGE_ORDER_COLUMNS.replace(/, /g, ", o.")}, c.name AS customer_name, c.phone AS customer_phone
             FROM vip_number_package_orders o
             JOIN customers c ON c.id = o.customer_id
             WHERE 1=1`;
  if (status && PACKAGE_ORDER_STATUSES.includes(status)) {
    args.push(status);
    sql += ` AND o.status=$${args.length}`;
  }
  if (search) {
    args.push(`%${search}%`);
    sql += ` AND (o.id ILIKE $${args.length} OR o.customer_full_name ILIKE $${args.length} OR c.phone ILIKE $${args.length})`;
  }
  sql += ` ORDER BY o.created_at DESC LIMIT 200`;
  sendJson(res, 200, await query(sql, args));
});

vipNumberPackagesRouter.get("/admin/vip-numbers/packages/orders/:id", requirePermission("vipNumbers.manage"), async (req, res) => {
  const order = await queryOne(
    `SELECT o.${PACKAGE_ORDER_COLUMNS.replace(/, /g, ", o.")}, c.name AS customer_name, c.phone AS customer_phone
     FROM vip_number_package_orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.id=$1`,
    [req.params.id]
  );
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  const items = await loadPackageOrderItems(req.params.id);
  const statusHistory = await loadPackageOrderStatusHistory(req.params.id);
  sendJson(res, 200, { ...order, items, statusHistory });
});

// Manual payment confirmation -- mirrors vipNumbers.routes.ts's identical
// /admin/vip-numbers/orders/:id/payment-status route (Admin sees the
// collection number receive the money and taps this once confirmed).
// Moves every member number to 'sold' here.
vipNumberPackagesRouter.put(
  "/admin/vip-numbers/packages/orders/:id/payment-status",
  requirePermission("vipNumbers.manage"),
  async (req, res) => {
    const existing = await queryOne<{ status: string; payment_status: string; customer_id: string; package_id: string }>(
      `SELECT status, payment_status, customer_id, package_id FROM vip_number_package_orders WHERE id=$1`,
      [req.params.id]
    );
    if (!existing) return sendJson(res, 404, { error: "Order not found" });
    if (existing.payment_status === "paid") return sendJson(res, 409, { error: "This order is already marked paid" });
    if (TERMINAL_PACKAGE_ORDER_STATUSES.includes(existing.status)) {
      return sendJson(res, 409, { error: `This order is already ${existing.status} and can no longer be marked paid` });
    }

    await query(
      `UPDATE vip_number_package_orders SET payment_status='paid', paid_at=now(),
         status = CASE WHEN status='pending' THEN 'processing' ELSE status END,
         verified_by_admin_id=$1, updated_at=now() WHERE id=$2`,
      [req.auth!.sub, req.params.id]
    );
    await query(
      `UPDATE vip_numbers SET status='sold', updated_at=now()
       WHERE id IN (SELECT vip_number_id FROM vip_number_package_items WHERE package_id=$1)`,
      [existing.package_id]
    );
    await recordActivity({
      adminId: req.auth!.sub,
      action: "vip_number_package_order_payment_confirmed",
      entityType: "vip_number_package_order",
      entityId: req.params.id,
      oldValue: { paymentStatus: existing.payment_status },
      newValue: { paymentStatus: "paid" },
    });
    if (existing.status === "pending") {
      await query(
        `INSERT INTO vip_number_package_order_status_history (package_order_id, status, note) VALUES ($1,'processing','Payment confirmed')`,
        [req.params.id]
      );
    }
    await notifyCustomer(
      existing.customer_id,
      "vip_number_package_order_update",
      "Payment Confirmed",
      `Your payment for VIP number package order ${req.params.id} has been confirmed. We're processing your numbers now.`
    );
    sendJson(
      res,
      200,
      await queryOne(`SELECT ${PACKAGE_ORDER_COLUMNS} FROM vip_number_package_orders WHERE id=$1`, [req.params.id])
    );
  }
);

// General status transitions -- mirrors vipNumbers.routes.ts's identical
// route, applied to every member number at once on cancel/fail.
vipNumberPackagesRouter.put(
  "/admin/vip-numbers/packages/orders/:id/status",
  requirePermission("vipNumbers.manage"),
  async (req, res) => {
    const { status, note } = req.body ?? {};
    if (!PACKAGE_ORDER_STATUSES.includes(status)) {
      return sendJson(res, 400, { error: `status must be one of ${PACKAGE_ORDER_STATUSES.join(", ")}` });
    }
    const existing = await queryOne<{ status: string; payment_status: string; customer_id: string; package_id: string }>(
      `SELECT status, payment_status, customer_id, package_id FROM vip_number_package_orders WHERE id=$1`,
      [req.params.id]
    );
    if (!existing) return sendJson(res, 404, { error: "Order not found" });
    if (TERMINAL_PACKAGE_ORDER_STATUSES.includes(existing.status)) {
      return sendJson(res, 409, { error: `This order is already ${existing.status} and cannot be changed further` });
    }
    if (status === "completed" && existing.payment_status !== "paid") {
      return sendJson(res, 409, { error: "Mark payment as paid before completing this order" });
    }

    if (AVAILABILITY_RESTORING_STATUSES.includes(status)) {
      await restorePackageNumbersAvailability(existing.package_id);
    }

    await query(
      `UPDATE vip_number_package_orders SET status=$1,
         completed_at = CASE WHEN $1='completed' THEN now() ELSE completed_at END,
         cancelled_at = CASE WHEN $1 IN ('cancelled','failed') THEN now() ELSE cancelled_at END,
         updated_at=now()
       WHERE id=$2`,
      [status, req.params.id]
    );
    await query(`INSERT INTO vip_number_package_order_status_history (package_order_id, status, note) VALUES ($1,$2,$3)`, [
      req.params.id,
      status,
      typeof note === "string" ? note.trim() || null : null,
    ]);
    await recordActivity({
      adminId: req.auth!.sub,
      action: "vip_number_package_order_status_changed",
      entityType: "vip_number_package_order",
      entityId: req.params.id,
      oldValue: { status: existing.status },
      newValue: { status },
    });
    const notification =
      status === "completed"
        ? { title: "VIP Number Package Ready", body: `Your VIP number package order ${req.params.id} has been completed.` }
        : status === "cancelled" || status === "failed"
          ? { title: "VIP Number Package Order Cancelled", body: `Your VIP number package order ${req.params.id} was cancelled.` }
          : null;
    if (notification) {
      await notifyCustomer(existing.customer_id, "vip_number_package_order_update", notification.title, notification.body);
    }
    sendJson(
      res,
      200,
      await queryOne(`SELECT ${PACKAGE_ORDER_COLUMNS} FROM vip_number_package_orders WHERE id=$1`, [req.params.id])
    );
  }
);
