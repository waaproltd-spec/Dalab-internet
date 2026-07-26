import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { generateUssdForOrder } from "./ussd.routes.js";

export const ordersRouter = Router();

const ORDER_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"];
const MACAASH_POINTS_PER_DOLLAR = 10;

function orderRef(): string {
  return "DLB" + Math.floor(100000000 + Math.random() * 900000000);
}

const ORDER_LIST_SELECT = `
  SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
         co.name AS company_name, co.color_hex AS company_color, p.name AS package_name
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  JOIN companies co ON co.id = o.company_id
  JOIN packages p ON p.id = o.package_id`;

async function loadOrder(id: string) {
  return queryOne(`${ORDER_LIST_SELECT} WHERE o.id=$1`, [id]);
}

// ---------------- Customer ----------------
ordersRouter.post("/orders", requireAuth("customer"), async (req, res) => {
  const { companyId, packageId, receiverPhone, paymentMethod } = req.body;
  const company = await queryOne(`SELECT * FROM companies WHERE id=$1`, [companyId]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });
  if (company.status === "offline") return sendJson(res, 409, { error: `${company.name} is currently offline` });

  const pkg = await queryOne(`SELECT * FROM packages WHERE id=$1 AND active=true`, [packageId]);
  if (!pkg) return sendJson(res, 404, { error: "Package not found" });

  const customer = await queryOne(`SELECT * FROM customers WHERE id=$1`, [req.auth!.sub]);
  const id = orderRef();
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, sender_phone, receiver_phone, payment_method, channel, macaash_earned)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,'android',$9)`,
    [
      id, req.auth!.sub, companyId, packageId, pkg.price,
      customer?.phone ?? null,
      receiverPhone || customer?.phone || null,
      paymentMethod || company.gateway || null,
      Math.round(pkg.price * MACAASH_POINTS_PER_DOLLAR),
    ]
  );
  sendJson(res, 201, await loadOrder(id));
});

ordersRouter.get("/orders", requireAuth("customer"), async (req, res) => {
  const rows = await query(
    `SELECT o.*, co.name AS company_name, p.name AS package_name
     FROM orders o JOIN companies co ON co.id=o.company_id JOIN packages p ON p.id=o.package_id
     WHERE o.customer_id=$1 ORDER BY o.created_at DESC`,
    [req.auth!.sub]
  );
  sendJson(res, 200, rows);
});

ordersRouter.get("/orders/:id", requireAuth("customer"), async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order || (order as any).customer_id !== req.auth!.sub) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, order);
});

// ---------------- Agent ----------------

// Agent-initiated sale — same validation/pricing/Macaash logic as the
// customer-initiated POST /orders above, but the customer is identified by
// phone (looked up or created on the spot, same as OTP verify does) since
// the agent — not the customer — is the one authenticated here.
ordersRouter.post("/agent/orders", requireAuth("agent"), async (req, res) => {
  const { customerPhone, companyId, packageId, receiverPhone, paymentMethod } = req.body;
  const phone = String(customerPhone ?? "").trim();
  if (!/^\+?\d{6,15}$/.test(phone)) return sendJson(res, 400, { error: "Provide a valid customer phone number" });

  const company = await queryOne(`SELECT * FROM companies WHERE id=$1`, [companyId]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });
  if (company.status === "offline") return sendJson(res, 409, { error: `${company.name} is currently offline` });

  const pkg = await queryOne(`SELECT * FROM packages WHERE id=$1 AND active=true`, [packageId]);
  if (!pkg) return sendJson(res, 404, { error: "Package not found" });

  let customer = await queryOne(`SELECT * FROM customers WHERE phone=$1`, [phone]);
  if (!customer) {
    customer = await queryOne(`INSERT INTO customers (id, phone) VALUES ($1,$2) RETURNING *`, [randomUUID(), phone]);
  }
  if (customer!.status === "blocked") return sendJson(res, 403, { error: "This customer's account has been blocked" });

  const id = orderRef();
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, sender_phone, receiver_phone, payment_method, channel, agent_id, macaash_earned)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,'agent',$9,$10)`,
    [
      id, customer!.id, companyId, packageId, pkg.price,
      phone,
      receiverPhone || phone,
      paymentMethod || company.gateway || null,
      req.auth!.sub,
      Math.round(pkg.price * MACAASH_POINTS_PER_DOLLAR),
    ]
  );
  sendJson(res, 201, await loadOrder(id));
});

ordersRouter.get("/agent/orders", requireAuth("agent"), async (req, res) => {
  const { status } = req.query;
  const rows = status
    ? await query(`${ORDER_LIST_SELECT} WHERE o.status=$1 ORDER BY o.created_at DESC`, [status])
    : await query(`${ORDER_LIST_SELECT} ORDER BY o.created_at DESC`);
  sendJson(res, 200, rows);
});

ordersRouter.get("/agent/orders/:id", requireAuth("agent"), async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, order);
});

ordersRouter.post("/agent/orders/:id/verify-payment", requireAuth("agent"), async (req, res) => {
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  if (order.status !== "pending") return sendJson(res, 409, { error: `Cannot verify an order in status '${order.status}'` });

  await query(`UPDATE orders SET status='in_progress', agent_id=$1, updated_at=now() WHERE id=$2`, [req.auth!.sub, order.id]);
  if (req.body.smsLogId) {
    await query(`UPDATE sms_logs SET matched_order_id=$1 WHERE id=$2`, [order.id, req.body.smsLogId]);
  }
  // Order approved — auto-generate the USSD dialer string. A missing PIN or
  // template isn't fatal to the approval itself; ussd_generated just stays
  // null until an admin sets one up, visible on the order detail either way.
  await generateUssdForOrder(order);
  sendJson(res, 200, await loadOrder(order.id));
});

async function creditMacaashIfNeeded(order: any) {
  if (order.macaash_earned > 0) {
    const already = await queryOne(`SELECT id FROM macaash_transactions WHERE order_id=$1`, [order.id]);
    if (!already) {
      await query(
        `INSERT INTO macaash_transactions (id, customer_id, order_id, points, reason) VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), order.customer_id, order.id, order.macaash_earned, `Earned from order ${order.id}`]
      );
      await query(`UPDATE customers SET macaash_points = macaash_points + $1 WHERE id=$2`, [order.macaash_earned, order.customer_id]);
    }
  }
}

ordersRouter.post("/agent/orders/:id/complete", requireAuth("agent"), async (req, res) => {
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  if (order.status !== "in_progress") return sendJson(res, 409, { error: "Order must be in progress before it can be completed" });

  await query(`UPDATE orders SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1`, [order.id]);
  await creditMacaashIfNeeded(order);
  sendJson(res, 200, await loadOrder(order.id));
});

ordersRouter.get("/agent/transactions", requireAuth("agent"), async (req, res) => {
  const rows = await query(
    `SELECT o.id AS order_id, c.name AS customer_name, co.name AS company_name, o.amount, o.completed_at
     FROM orders o JOIN customers c ON c.id=o.customer_id JOIN companies co ON co.id=o.company_id
     WHERE o.agent_id=$1 AND o.status='completed' ORDER BY o.completed_at DESC`,
    [req.auth!.sub]
  );
  sendJson(res, 200, rows);
});

// ---------------- Admin/Staff: Orders Management ----------------
ordersRouter.get("/admin/orders", requireStaff(), async (req, res) => {
  const { status, companyId, search } = req.query as Record<string, string | undefined>;
  let sql = `${ORDER_LIST_SELECT} WHERE 1=1`;
  const args: unknown[] = [];
  if (status) { args.push(status); sql += ` AND o.status=$${args.length}`; }
  if (companyId) { args.push(companyId); sql += ` AND o.company_id=$${args.length}`; }
  if (search) {
    args.push(`%${search}%`);
    const idx = args.length;
    sql += ` AND (o.id ILIKE $${idx} OR c.name ILIKE $${idx} OR o.sender_phone ILIKE $${idx} OR o.receiver_phone ILIKE $${idx} OR c.phone ILIKE $${idx})`;
  }
  sql += ` ORDER BY o.created_at DESC`;
  sendJson(res, 200, await query(sql, args));
});

ordersRouter.get("/admin/orders/counts", requireStaff(), async (req, res) => {
  const { companyId } = req.query;
  const rows = companyId
    ? await query(`SELECT status, COUNT(*) AS n FROM orders WHERE company_id=$1 GROUP BY status`, [companyId])
    : await query(`SELECT status, COUNT(*) AS n FROM orders GROUP BY status`);

  const counts = { pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0, all: 0 };
  for (const row of rows as { status: string; n: string }[]) {
    const n = Number(row.n);
    counts.all += n;
    if (row.status === "pending") counts.pending = n;
    else if (row.status === "in_progress") counts.inProgress = n;
    else if (row.status === "completed") counts.completed = n;
    else if (row.status === "failed") counts.failed = n;
    else if (row.status === "cancelled") counts.cancelled = n;
  }
  sendJson(res, 200, counts);
});

ordersRouter.get("/admin/orders/:id", requireStaff(), async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, order);
});

ordersRouter.put("/admin/orders/:id/status", requireStaff(), async (req, res) => {
  const { status } = req.body;
  if (!ORDER_STATUSES.includes(status)) return sendJson(res, 400, { error: `status must be one of ${ORDER_STATUSES.join(", ")}` });
  const order = await queryOne(`SELECT * FROM orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });

  if (status === "completed") {
    await query(`UPDATE orders SET status=$1, completed_at=now(), updated_at=now() WHERE id=$2`, [status, req.params.id]);
    if (order.status !== "completed") await creditMacaashIfNeeded(order);
  } else {
    await query(`UPDATE orders SET status=$1, updated_at=now() WHERE id=$2`, [status, req.params.id]);
    if (status === "in_progress" && order.status !== "in_progress") {
      await generateUssdForOrder(order, req.auth!.sub);
    }
  }
  sendJson(res, 200, await loadOrder(req.params.id));
});

ordersRouter.get("/admin/dashboard/stats", requireStaff(), async (_req, res) => {
  const totals = await queryOne(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE status='completed'), 0) AS total_sales,
       COUNT(*) FILTER (WHERE status='pending') AS pending_orders,
       COUNT(*) FILTER (WHERE status='completed') AS successful_orders,
       COUNT(*) FILTER (WHERE status='failed') AS failed_orders
     FROM orders`
  );
  const activeCustomers = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM customers WHERE status='active'`);
  sendJson(res, 200, { ...totals, active_customers: activeCustomers?.n });
});
