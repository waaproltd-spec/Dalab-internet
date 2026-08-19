import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { adjustResellerWallet } from "../utils/resellerWallet.js";
import { validateMobileNumber, companyKeyFromLabel } from "../lib/phoneValidation.js";

export const resellerOrdersRouter = Router();

function resellerOrderRef(): string {
  return "DRS" + Math.floor(100000000 + Math.random() * 900000000);
}

const ORDER_LIST_SELECT = `
  SELECT o.*, c.name AS company_name, c.color_hex AS company_color
  FROM reseller_orders o
  JOIN companies c ON c.id = o.company_id
`;

// ---------------- Reseller-facing ----------------

// Freezes rate_applied/amount_calculated from reseller_company_rates at this
// exact moment — never re-read after insertion, so a later admin rate
// change can never retroactively affect this order (mirrors
// exchange.routes.ts's computeQuote-then-INSERT pattern).
resellerOrdersRouter.post("/reseller/orders", requireAuth("reseller"), async (req, res) => {
  const companyId = String(req.body.companyId ?? "");
  const receivingNumber = String(req.body.receivingNumber ?? "").trim();
  const amount = Number(req.body.amount);
  const clientRequestId = req.body.clientRequestId ? String(req.body.clientRequestId) : null;

  if (!companyId || !receivingNumber || !Number.isFinite(amount) || amount <= 0) {
    return sendJson(res, 400, { error: "companyId, receivingNumber, and a positive amount are required" });
  }
  const company = await queryOne<{ id: string; name: string }>(`SELECT id, name FROM companies WHERE id=$1 AND deleted_at IS NULL`, [companyId]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });
  const receivingNumberCheck = validateMobileNumber(receivingNumber, companyKeyFromLabel(company.id) ?? companyKeyFromLabel(company.name));
  if (!receivingNumberCheck.valid) return sendJson(res, 400, { error: receivingNumberCheck.error });

  const rateRow = await queryOne<{ rate: string }>(`SELECT rate FROM reseller_company_rates WHERE company_id=$1`, [companyId]);
  if (!rateRow) return sendJson(res, 400, { error: "No rate is configured for this company yet — ask Admin to set one" });
  const rate = Number(rateRow.rate);
  const amountCalculated = Math.round(amount * rate * 100) / 100;

  const id = resellerOrderRef();
  try {
    await query(
      `INSERT INTO reseller_orders (id, reseller_id, company_id, receiving_number, amount, rate_applied, amount_calculated, client_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, req.auth!.sub, companyId, receivingNumber, amount, rate, amountCalculated, clientRequestId]
    );
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === "23505" && pgErr.constraint === "idx_reseller_orders_client_request_id") {
      const existing = await queryOne(`${ORDER_LIST_SELECT} WHERE o.client_request_id=$1`, [clientRequestId]);
      return sendJson(res, 200, existing);
    }
    throw err;
  }
  sendJson(res, 201, await queryOne(`${ORDER_LIST_SELECT} WHERE o.id=$1`, [id]));
});

// Capped at 100 -- was unbounded; see orders.routes.ts's GET /orders for
// the same fix and reasoning.
resellerOrdersRouter.get("/reseller/orders", requireAuth("reseller"), async (req, res) => {
  sendJson(res, 200, await query(`${ORDER_LIST_SELECT} WHERE o.reseller_id=$1 ORDER BY o.created_at DESC LIMIT 100`, [req.auth!.sub]));
});

resellerOrdersRouter.get("/reseller/orders/:id", requireAuth("reseller"), async (req, res) => {
  const order = await queryOne(`${ORDER_LIST_SELECT} WHERE o.id=$1 AND o.reseller_id=$2`, [req.params.id, req.auth!.sub]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, order);
});

// The reseller has sent the money externally and is telling Dalab so —
// atomic CAS, never a blind UPDATE, matching every other status transition
// in this codebase.
resellerOrdersRouter.put("/reseller/orders/:id/payment-sent", requireAuth("reseller"), async (req, res) => {
  const rows = await query(
    `UPDATE reseller_orders SET status='payment_sent', payment_sent_at=now(), updated_at=now()
     WHERE id=$1 AND reseller_id=$2 AND status='pending' RETURNING id`,
    [req.params.id, req.auth!.sub]
  );
  if (rows.length === 0) return sendJson(res, 409, { error: "Order not found, not yours, or not in a pending state" });
  sendJson(res, 200, await queryOne(`${ORDER_LIST_SELECT} WHERE o.id=$1`, [req.params.id]));
});

// ---------------- Admin-facing ----------------

resellerOrdersRouter.get("/admin/reseller-orders", requireStaff(), async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const params: unknown[] = [];
  let sql = `SELECT o.*, c.name AS company_name, r.reseller_login_id, r.name AS reseller_name
             FROM reseller_orders o
             JOIN companies c ON c.id = o.company_id
             JOIN resellers r ON r.id = o.reseller_id`;
  if (status) {
    params.push(status);
    sql += ` WHERE o.status=$1`;
  }
  sql += ` ORDER BY o.created_at DESC`;
  sendJson(res, 200, await query(sql, params));
});

resellerOrdersRouter.get("/admin/reseller-orders/:id", requireStaff(), async (req, res) => {
  const order = await queryOne(
    `SELECT o.*, c.name AS company_name, r.reseller_login_id, r.name AS reseller_name
     FROM reseller_orders o JOIN companies c ON c.id = o.company_id JOIN resellers r ON r.id = o.reseller_id
     WHERE o.id=$1`,
    [req.params.id]
  );
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  sendJson(res, 200, order);
});

// "After Admin Confirm -> reseller balance is updated" (spec, Req. 6) — the
// wallet debit happens exactly here, atomically with the status flip, via
// the single shared adjustResellerWallet helper. CAS from 'payment_sent'
// only, so a double-click or retried request can never double-debit (the
// second attempt finds status is no longer 'payment_sent' and 409s).
resellerOrdersRouter.put("/admin/reseller-orders/:id/confirm", requirePermission("resellers.manage"), async (req, res) => {
  const order = await queryOne(`SELECT * FROM reseller_orders WHERE id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Order not found" });
  if (order.status !== "payment_sent") {
    return sendJson(res, 409, { error: `Order is '${order.status}', not 'payment_sent' — cannot confirm` });
  }

  let walletResult;
  try {
    walletResult = await adjustResellerWallet({
      resellerId: order.reseller_id,
      changeAmount: -Number(order.amount),
      referenceType: "order",
      referenceId: order.id,
      source: "admin_manual",
      changedByAdminId: req.auth!.sub,
    });
  } catch (err) {
    return sendJson(res, 400, { error: (err as Error).message });
  }

  const rows = await query(
    `UPDATE reseller_orders SET status='confirmed', confirmed_at=now(), verified_by_admin_id=$1, updated_at=now()
     WHERE id=$2 AND status='payment_sent' RETURNING id`,
    [req.auth!.sub, req.params.id]
  );
  if (rows.length === 0) {
    // Extremely unlikely (status changed between the SELECT above and this
    // UPDATE) — the wallet debit already committed, so surface it clearly
    // rather than silently losing track of the money movement.
    return sendJson(res, 500, { error: "Wallet was debited but the order status change lost a race — check admin activity log" });
  }
  sendJson(res, 200, { id: req.params.id, status: "confirmed", wallet: walletResult });
});

// Pure bookkeeping close-out — no balance effect, the debit already
// happened at confirm.
resellerOrdersRouter.put("/admin/reseller-orders/:id/complete", requirePermission("resellers.manage"), async (req, res) => {
  const rows = await query(
    `UPDATE reseller_orders SET status='completed', completed_at=now(), updated_at=now()
     WHERE id=$1 AND status='confirmed' RETURNING id`,
    [req.params.id]
  );
  if (rows.length === 0) return sendJson(res, 409, { error: "Order not found or not in a confirmed state" });
  sendJson(res, 200, { id: req.params.id, status: "completed" });
});

// Only safe before any wallet debit has happened — CAS restricted to
// 'pending'/'payment_sent', matching where 'confirm' itself is restricted to.
resellerOrdersRouter.put("/admin/reseller-orders/:id/cancel", requirePermission("resellers.manage"), async (req, res) => {
  const rows = await query(
    `UPDATE reseller_orders SET status='cancelled', cancelled_at=now(), updated_at=now()
     WHERE id=$1 AND status IN ('pending','payment_sent') RETURNING id`,
    [req.params.id]
  );
  if (rows.length === 0) return sendJson(res, 409, { error: "Order not found or already past the point where it can be cancelled" });
  sendJson(res, 200, { id: req.params.id, status: "cancelled" });
});
