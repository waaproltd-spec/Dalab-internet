import { randomUUID } from "node:crypto";
import { requireAuth } from "../auth/middleware.js";
import { generateUssdForOrder } from "./ussd.js";

const MACAASH_POINTS_PER_DOLLAR = 10;
const ORDER_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"];

function orderRef() {
  return "DLB" + Math.floor(100000000 + Math.random() * 900000000);
}

function loadOrder(db, id) {
  return db.prepare(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
            co.name AS company_name, p.name AS package_name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN companies co ON co.id = o.company_id
     JOIN packages p ON p.id = o.package_id
     WHERE o.id = ?`
  ).get(id);
}

// Shared SELECT used everywhere an order list needs the full card payload
// (provider, package, price, sender/receiver, customer, dates, payment
// method) in one query rather than N+1 lookups.
const ORDER_LIST_SELECT = `
  SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
         co.name AS company_name, co.color_hex AS company_color, p.name AS package_name
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  JOIN companies co ON co.id = o.company_id
  JOIN packages p ON p.id = o.package_id`;

export function registerOrderRoutes(app, db) {
  // ---------------- Customer ----------------
  app.post("/orders", requireAuth("customer"), async (ctx) => {
    const { companyId, packageId, receiverPhone, paymentMethod } = ctx.body;
    const company = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(companyId);
    if (!company) return ctx.json(404, { error: "Company not found" });
    if (company.status === "offline") return ctx.json(409, { error: `${company.name} is currently offline` });

    const pkg = db.prepare(`SELECT * FROM packages WHERE id = ? AND active = 1`).get(packageId);
    if (!pkg) return ctx.json(404, { error: "Package not found" });

    const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(ctx.auth.sub);
    const id = orderRef();
    db.prepare(
      `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, sender_phone, receiver_phone, payment_method, channel, macaash_earned)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'android', ?)`
    ).run(
      id, ctx.auth.sub, companyId, packageId, pkg.price,
      customer?.phone ?? null,
      receiverPhone || customer?.phone || null,
      paymentMethod || company.gateway || null,
      Math.round(pkg.price * MACAASH_POINTS_PER_DOLLAR)
    );

    ctx.json(201, loadOrder(db, id));
  });

  app.get("/orders", requireAuth("customer"), async (ctx) => {
    const rows = db.prepare(
      `SELECT o.*, co.name AS company_name, p.name AS package_name
       FROM orders o JOIN companies co ON co.id = o.company_id JOIN packages p ON p.id = o.package_id
       WHERE o.customer_id = ? ORDER BY o.created_at DESC`
    ).all(ctx.auth.sub);
    ctx.json(200, rows);
  });

  app.get("/orders/:id", requireAuth("customer"), async (ctx) => {
    const order = loadOrder(db, ctx.params.id);
    if (!order || order.customer_id !== ctx.auth.sub) return ctx.json(404, { error: "Order not found" });
    ctx.json(200, order);
  });

  // ---------------- Agent ----------------
  app.get("/agent/orders", requireAuth("agent"), async (ctx) => {
    const status = ctx.query.status;
    const rows = status
      ? db.prepare(`${ORDER_LIST_SELECT} WHERE o.status = ? ORDER BY o.created_at DESC`).all(status)
      : db.prepare(`${ORDER_LIST_SELECT} ORDER BY o.created_at DESC`).all();
    ctx.json(200, rows);
  });

  app.get("/agent/orders/:id", requireAuth("agent"), async (ctx) => {
    const order = loadOrder(db, ctx.params.id);
    if (!order) return ctx.json(404, { error: "Order not found" });
    ctx.json(200, order);
  });

  app.post("/agent/orders/:id/verify-payment", requireAuth("agent"), async (ctx) => {
    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(ctx.params.id);
    if (!order) return ctx.json(404, { error: "Order not found" });
    if (order.status !== "pending") return ctx.json(409, { error: `Cannot verify an order in status '${order.status}'` });

    db.prepare(
      `UPDATE orders SET status='in_progress', agent_id=?, updated_at=datetime('now') WHERE id=?`
    ).run(ctx.auth.sub, order.id);
    if (ctx.body.smsLogId) {
      db.prepare(`UPDATE sms_logs SET matched_order_id = ? WHERE id = ?`).run(order.id, ctx.body.smsLogId);
    }

    // Order approved — auto-generate the USSD dialer string. A missing PIN
    // or template isn't fatal to the approval itself (the order still moves
    // to in_progress); it just means ussd_generated stays null until an
    // admin sets one up, visible on the order detail page either way.
    generateUssdForOrder(db, order);

    ctx.json(200, loadOrder(db, order.id));
  });

  app.post("/agent/orders/:id/complete", requireAuth("agent"), async (ctx) => {
    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(ctx.params.id);
    if (!order) return ctx.json(404, { error: "Order not found" });
    if (order.status !== "in_progress") return ctx.json(409, { error: "Order must be in progress before it can be completed" });

    db.prepare(
      `UPDATE orders SET status='completed', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run(order.id);

    // Credit Macaash points now that the order is genuinely fulfilled, not
    // just requested — mirrors the customer app's "earned from <package>" ledger.
    if (order.macaash_earned > 0) {
      db.prepare(
        `INSERT INTO macaash_transactions (id, customer_id, order_id, points, reason) VALUES (?, ?, ?, ?, ?)`
      ).run(randomUUID(), order.customer_id, order.id, order.macaash_earned, `Earned from order ${order.id}`);
      db.prepare(`UPDATE customers SET macaash_points = macaash_points + ? WHERE id = ?`)
        .run(order.macaash_earned, order.customer_id);
    }
    ctx.json(200, loadOrder(db, order.id));
  });

  app.get("/agent/transactions", requireAuth("agent"), async (ctx) => {
    const rows = db.prepare(
      `SELECT o.id AS order_id, c.name AS customer_name, co.name AS company_name, o.amount, o.completed_at
       FROM orders o JOIN customers c ON c.id=o.customer_id JOIN companies co ON co.id=o.company_id
       WHERE o.agent_id = ? AND o.status = 'completed' ORDER BY o.completed_at DESC`
    ).all(ctx.auth.sub);
    ctx.json(200, rows);
  });

  // ---------------- Admin: Orders Management ----------------

  // Full card data + search (order ID, customer name, sender phone, receiver
  // phone) + filter (status, provider). This is the single endpoint the
  // admin Orders page's card grid is built on.
  app.get("/admin/orders", requireAuth("super_admin"), async (ctx) => {
    const { status, companyId, search } = ctx.query;
    let sql = `${ORDER_LIST_SELECT} WHERE 1=1`;
    const args = [];
    if (status) { sql += ` AND o.status = ?`; args.push(status); }
    if (companyId) { sql += ` AND o.company_id = ?`; args.push(companyId); }
    if (search) {
      sql += ` AND (o.id LIKE ? OR c.name LIKE ? OR o.sender_phone LIKE ? OR o.receiver_phone LIKE ? OR c.phone LIKE ?)`;
      const like = `%${search}%`;
      args.push(like, like, like, like, like);
    }
    sql += ` ORDER BY o.created_at DESC`;
    ctx.json(200, db.prepare(sql).all(...args));
  });

  // Counts for every status, independent of whatever filter/search is
  // currently applied in the UI — so the status tab badges (Pending 4,
  // In Progress 2, ...) stay accurate even while a filter narrows the list
  // below them. Optionally scoped to one provider via ?companyId=.
  app.get("/admin/orders/counts", requireAuth("super_admin"), async (ctx) => {
    const { companyId } = ctx.query;
    let sql = `SELECT status, COUNT(*) AS n FROM orders`;
    const args = [];
    if (companyId) { sql += ` WHERE company_id = ?`; args.push(companyId); }
    sql += ` GROUP BY status`;
    const rows = db.prepare(sql).all(...args);
    const counts = { pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0, all: 0 };
    for (const row of rows) {
      counts.all += row.n;
      if (row.status === "pending") counts.pending = row.n;
      else if (row.status === "in_progress") counts.inProgress = row.n;
      else if (row.status === "completed") counts.completed = row.n;
      else if (row.status === "failed") counts.failed = row.n;
      else if (row.status === "cancelled") counts.cancelled = row.n;
    }
    ctx.json(200, counts);
  });

  app.get("/admin/orders/:id", requireAuth("super_admin"), async (ctx) => {
    const order = loadOrder(db, ctx.params.id);
    if (!order) return ctx.json(404, { error: "Order not found" });
    ctx.json(200, order);
  });

  // One-tap status change from the admin Orders page. Completing an order
  // this way (bypassing the agent flow) still credits Macaash the same way
  // the agent's /complete endpoint does, so the two paths stay consistent.
  app.put("/admin/orders/:id/status", requireAuth("super_admin"), async (ctx) => {
    const { status } = ctx.body;
    if (!ORDER_STATUSES.includes(status)) {
      return ctx.json(400, { error: `status must be one of ${ORDER_STATUSES.join(", ")}` });
    }
    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(ctx.params.id);
    if (!order) return ctx.json(404, { error: "Order not found" });

    const completedAtClause = status === "completed" ? `, completed_at = datetime('now')` : "";
    db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now')${completedAtClause} WHERE id = ?`)
      .run(status, ctx.params.id);

    // Order approved (moved into in_progress) — auto-generate the USSD
    // dialer string, same as the agent approval path above.
    if (status === "in_progress" && order.status !== "in_progress") {
      generateUssdForOrder(db, order, ctx.auth.sub);
    }

    if (status === "completed" && order.status !== "completed" && order.macaash_earned > 0) {
      const alreadyCredited = db.prepare(`SELECT id FROM macaash_transactions WHERE order_id = ?`).get(order.id);
      if (!alreadyCredited) {
        db.prepare(
          `INSERT INTO macaash_transactions (id, customer_id, order_id, points, reason) VALUES (?, ?, ?, ?, ?)`
        ).run(randomUUID(), order.customer_id, order.id, order.macaash_earned, `Earned from order ${order.id}`);
        db.prepare(`UPDATE customers SET macaash_points = macaash_points + ? WHERE id = ?`)
          .run(order.macaash_earned, order.customer_id);
      }
    }

    ctx.json(200, loadOrder(db, ctx.params.id));
  });

  app.get("/admin/dashboard/stats", requireAuth("super_admin"), async (ctx) => {
    const totals = db.prepare(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) AS total_sales,
         COUNT(*) FILTER (WHERE status = 'pending') AS pending_orders,
         COUNT(*) FILTER (WHERE status = 'completed') AS successful_orders,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_orders
       FROM orders`
    ).get();
    const activeCustomers = db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE status = 'active'`).get();
    ctx.json(200, { ...totals, active_customers: activeCustomers.n });
  });
}
