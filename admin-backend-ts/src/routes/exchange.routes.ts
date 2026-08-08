import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { encrypt, decrypt, isValidPin } from "../auth/crypto.js";
import { sendJson } from "../utils/camelCase.js";
import { broadcast } from "../realtime/orderEvents.js";
import { recordActivity } from "../utils/activityLog.js";

export const exchangeRouter = Router();

const EXCHANGE_ORDER_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"];

function exchangeOrderRef(): string {
  return "DEX" + Math.floor(100000000 + Math.random() * 900000000);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** amountReceived = amountSent * rate - fee, matching the admin's spec
 * literally — fee_value is a flat amount when fee_type='fixed', a percentage
 * of amountSent when fee_type='percentage'. Never lets amountReceived go
 * negative (a misconfigured corridor shouldn't produce a nonsensical quote). */
function computeQuote(
  amountSent: number,
  corridor: { rate: string | number; fee_type: string; fee_value: string | number }
): { rate: number; fee: number; amountReceived: number } {
  const rate = Number(corridor.rate);
  const feeValue = Number(corridor.fee_value);
  const fee = corridor.fee_type === "percentage" ? round2(amountSent * (feeValue / 100)) : round2(feeValue);
  const amountReceived = round2(Math.max(0, amountSent * rate - fee));
  return { rate, fee, amountReceived };
}

/** Defense-in-depth: even though the carrier's own response text shouldn't
 * echo back a PIN it was just given, strip any exact occurrence before this
 * text is ever written to the database or returned to a client. */
function scrubPin(text: string | null | undefined, pin: string): string | null {
  if (!text) return text ?? null;
  if (!pin) return text;
  return text.split(pin).join("••••");
}

async function loadCorridor(id: string) {
  return queryOne<{
    id: string;
    from_wallet_id: string;
    to_wallet_id: string;
    rate: string;
    fee_type: string;
    fee_value: string;
    min_amount: string | null;
    max_amount: string | null;
    payout_wallet_id: string | null;
    enabled: boolean;
  }>(`SELECT * FROM exchange_corridors WHERE id=$1`, [id]);
}

async function loadPayoutWallet(id: string) {
  return queryOne<{
    id: string;
    wallet_id: string;
    device_id: string | null;
    sim_slot: number | null;
    phone_number: string;
    pin_encrypted: string | null;
  }>(`SELECT * FROM exchange_payout_wallets WHERE id=$1`, [id]);
}

// ---------------- Wallet catalog (reuses payment_wallets) ----------------

exchangeRouter.get("/admin/exchange/wallets", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM payment_wallets WHERE enabled=true ORDER BY sort_order`));
});

// ---------------- Payout wallets (Super-Admin-only — holds the PIN) ----------------
// Mirrors companies' USSD PIN management exactly: PIN is Super-Admin-exclusive
// and never leaves the server except inlined into one specific, already-
// authorized dial-attempt response (see POST .../dial-attempts below).

const PAYOUT_WALLET_SELECT = `
  SELECT epw.id, epw.wallet_id, pw.name AS wallet_name, epw.device_id, ad.name AS device_name,
         epw.sim_slot, epw.phone_number, (epw.pin_encrypted IS NOT NULL) AS pin_is_set,
         epw.created_at, epw.updated_at
  FROM exchange_payout_wallets epw
  LEFT JOIN payment_wallets pw ON pw.id = epw.wallet_id
  LEFT JOIN agent_devices ad ON ad.id = epw.device_id
`;

exchangeRouter.get("/admin/exchange/payout-wallets", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`${PAYOUT_WALLET_SELECT} ORDER BY epw.created_at DESC`));
});

exchangeRouter.post("/admin/exchange/payout-wallets", requireAuth("super_admin"), async (req, res) => {
  const { walletId, deviceId, simSlot, phoneNumber } = req.body ?? {};
  if (!walletId || typeof walletId !== "string") return sendJson(res, 400, { error: "walletId is required" });
  if (!phoneNumber || typeof phoneNumber !== "string") return sendJson(res, 400, { error: "phoneNumber is required" });
  const wallet = await queryOne(`SELECT id FROM payment_wallets WHERE id=$1`, [walletId]);
  if (!wallet) return sendJson(res, 404, { error: "Wallet not found" });

  const id = randomUUID();
  await query(
    `INSERT INTO exchange_payout_wallets (id, wallet_id, device_id, sim_slot, phone_number) VALUES ($1,$2,$3,$4,$5)`,
    [id, walletId, deviceId || null, simSlot ?? null, phoneNumber]
  );
  sendJson(res, 201, await queryOne(`${PAYOUT_WALLET_SELECT} WHERE epw.id=$1`, [id]));
});

exchangeRouter.put("/admin/exchange/payout-wallets/:id", requireAuth("super_admin"), async (req, res) => {
  const existing = await loadPayoutWallet(req.params.id);
  if (!existing) return sendJson(res, 404, { error: "Payout wallet not found" });
  const { deviceId, simSlot, phoneNumber } = req.body ?? {};
  if (!phoneNumber || typeof phoneNumber !== "string") return sendJson(res, 400, { error: "phoneNumber is required" });
  await query(
    `UPDATE exchange_payout_wallets SET device_id=$1, sim_slot=$2, phone_number=$3, updated_at=now() WHERE id=$4`,
    [deviceId || null, simSlot ?? null, phoneNumber, req.params.id]
  );
  sendJson(res, 200, await queryOne(`${PAYOUT_WALLET_SELECT} WHERE epw.id=$1`, [req.params.id]));
});

// Separate, write-only endpoint for the PIN itself — never returned by any
// GET above (only a boolean pinIsSet flag), and the activity log records
// only that it changed, never the value, matching PUT /admin/companies/:id/pin.
exchangeRouter.put("/admin/exchange/payout-wallets/:id/pin", requireAuth("super_admin"), async (req, res) => {
  const { pin } = req.body ?? {};
  if (!isValidPin(String(pin ?? ""))) return sendJson(res, 400, { error: "PIN must be 4-8 digits" });
  const existing = await loadPayoutWallet(req.params.id);
  if (!existing) return sendJson(res, 404, { error: "Payout wallet not found" });

  await query(`UPDATE exchange_payout_wallets SET pin_encrypted=$1, updated_at=now() WHERE id=$2`, [encrypt(pin), req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_exchange_payout_pin",
    entityType: "exchange_payout_wallet",
    entityId: req.params.id,
    oldValue: { pinSet: Boolean(existing.pin_encrypted) },
    newValue: { pinSet: true },
  });
  sendJson(res, 200, { message: "PIN saved" });
});

// ---------------- Corridors (rate/fee — delegable via exchange.manage) ----------------

const CORRIDOR_SELECT = `
  SELECT ec.*, fw.name AS from_wallet_name, tw.name AS to_wallet_name
  FROM exchange_corridors ec
  LEFT JOIN payment_wallets fw ON fw.id = ec.from_wallet_id
  LEFT JOIN payment_wallets tw ON tw.id = ec.to_wallet_id
`;

exchangeRouter.get("/admin/exchange/corridors", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`${CORRIDOR_SELECT} ORDER BY ec.created_at DESC`));
});

function validateCorridorBody(body: any): { error?: string } {
  const { fromWalletId, toWalletId, rate, feeType, feeValue } = body ?? {};
  if (!fromWalletId || !toWalletId) return { error: "fromWalletId and toWalletId are required" };
  if (fromWalletId === toWalletId) return { error: "fromWalletId and toWalletId must be different" };
  const numRate = Number(rate);
  if (!Number.isFinite(numRate) || numRate <= 0) return { error: "rate must be a positive number" };
  if (!["fixed", "percentage"].includes(feeType)) return { error: "feeType must be 'fixed' or 'percentage'" };
  const numFee = Number(feeValue);
  if (!Number.isFinite(numFee) || numFee < 0) return { error: "feeValue must be a non-negative number" };
  return {};
}

exchangeRouter.post("/admin/exchange/corridors", requirePermission("exchange.manage"), async (req, res) => {
  const check = validateCorridorBody(req.body);
  if (check.error) return sendJson(res, 400, { error: check.error });
  const { fromWalletId, toWalletId, rate, feeType, feeValue, minAmount, maxAmount, payoutWalletId } = req.body;

  const id = randomUUID();
  try {
    await query(
      `INSERT INTO exchange_corridors (id, from_wallet_id, to_wallet_id, rate, fee_type, fee_value, min_amount, max_amount, payout_wallet_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, fromWalletId, toWalletId, rate, feeType, feeValue, minAmount || null, maxAmount || null, payoutWalletId || null]
    );
  } catch (err: any) {
    if (err?.code === "23505") return sendJson(res, 409, { error: "A corridor for this wallet pair already exists" });
    throw err;
  }
  await recordActivity({
    adminId: req.auth!.sub,
    action: "create_exchange_corridor",
    entityType: "exchange_corridor",
    entityId: id,
    oldValue: null,
    newValue: { fromWalletId, toWalletId, rate, feeType, feeValue },
  });
  sendJson(res, 201, await queryOne(`${CORRIDOR_SELECT} WHERE ec.id=$1`, [id]));
});

exchangeRouter.put("/admin/exchange/corridors/:id", requirePermission("exchange.manage"), async (req, res) => {
  const existing = await loadCorridor(req.params.id);
  if (!existing) return sendJson(res, 404, { error: "Corridor not found" });
  const check = validateCorridorBody(req.body);
  if (check.error) return sendJson(res, 400, { error: check.error });
  const { fromWalletId, toWalletId, rate, feeType, feeValue, minAmount, maxAmount, payoutWalletId, enabled } = req.body;

  await query(
    `UPDATE exchange_corridors
     SET from_wallet_id=$1, to_wallet_id=$2, rate=$3, fee_type=$4, fee_value=$5,
         min_amount=$6, max_amount=$7, payout_wallet_id=$8, enabled=$9, updated_at=now()
     WHERE id=$10`,
    [
      fromWalletId, toWalletId, rate, feeType, feeValue,
      minAmount || null, maxAmount || null, payoutWalletId || null,
      enabled !== undefined ? Boolean(enabled) : existing.enabled,
      req.params.id,
    ]
  );
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_exchange_corridor",
    entityType: "exchange_corridor",
    entityId: req.params.id,
    oldValue: existing,
    newValue: { fromWalletId, toWalletId, rate, feeType, feeValue, enabled },
  });
  sendJson(res, 200, await queryOne(`${CORRIDOR_SELECT} WHERE ec.id=$1`, [req.params.id]));
});

// ---------------- Quote (staff + agent) ----------------

async function handleQuote(req: any, res: any) {
  const corridorId = String(req.query.corridorId ?? "");
  const amountSent = Number(req.query.amount ?? 0);
  if (!corridorId) return sendJson(res, 400, { error: "corridorId is required" });
  if (!Number.isFinite(amountSent) || amountSent <= 0) return sendJson(res, 400, { error: "amount must be a positive number" });

  const corridor = await loadCorridor(corridorId);
  if (!corridor || !corridor.enabled) return sendJson(res, 404, { error: "Corridor not found or disabled" });
  if (corridor.min_amount && amountSent < Number(corridor.min_amount)) {
    return sendJson(res, 400, { error: `Minimum amount for this corridor is ${corridor.min_amount}` });
  }
  if (corridor.max_amount && amountSent > Number(corridor.max_amount)) {
    return sendJson(res, 400, { error: `Maximum amount for this corridor is ${corridor.max_amount}` });
  }
  const { rate, fee, amountReceived } = computeQuote(amountSent, corridor);
  sendJson(res, 200, { corridorId, amountSent, rate, fee, amountReceived });
}

exchangeRouter.get("/admin/exchange/quote", requireStaff(), handleQuote);
exchangeRouter.get("/agent/exchange/quote", requireAuth("agent"), handleQuote);

// ---------------- Orders: creation ----------------

async function createExchangeOrder(params: {
  corridorId: string;
  amountSent: number;
  senderPhone: string;
  receiverPhone: string;
  customerPhone?: string;
  channel: "admin" | "agent";
  agentId?: string;
  adminId?: string;
}): Promise<{ error?: string; status?: number; order?: any }> {
  const corridor = await loadCorridor(params.corridorId);
  if (!corridor || !corridor.enabled) return { error: "Corridor not found or disabled", status: 404 };
  if (corridor.min_amount && params.amountSent < Number(corridor.min_amount)) {
    return { error: `Minimum amount for this corridor is ${corridor.min_amount}`, status: 400 };
  }
  if (corridor.max_amount && params.amountSent > Number(corridor.max_amount)) {
    return { error: `Maximum amount for this corridor is ${corridor.max_amount}`, status: 400 };
  }
  const { rate, fee, amountReceived } = computeQuote(params.amountSent, corridor);

  let customerId: string | null = null;
  if (params.customerPhone) {
    let customer = await queryOne<{ id: string; status: string }>(`SELECT id, status FROM customers WHERE phone=$1`, [params.customerPhone]);
    if (!customer) {
      customer = await queryOne(`INSERT INTO customers (id, phone) VALUES ($1,$2) RETURNING id, status`, [randomUUID(), params.customerPhone]);
    }
    if (customer!.status === "blocked") return { error: "This customer's account has been blocked", status: 403 };
    customerId = customer!.id;
  }

  const id = exchangeOrderRef();
  await query(
    `INSERT INTO exchange_orders
       (id, customer_id, corridor_id, from_wallet_id, to_wallet_id, amount_sent, rate_applied, fee_applied,
        amount_received, sender_phone, receiver_phone, channel, agent_id, created_by_admin_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id, customerId, corridor.id, corridor.from_wallet_id, corridor.to_wallet_id, params.amountSent, rate, fee,
      amountReceived, params.senderPhone, params.receiverPhone, params.channel, params.agentId ?? null, params.adminId ?? null,
    ]
  );
  const order = await queryOne(`SELECT * FROM exchange_orders WHERE id=$1`, [id]);
  broadcast({ type: "exchange_order.updated", exchangeOrderId: id });
  return { order };
}

exchangeRouter.post("/admin/exchange/orders", requirePermission("exchange.manage"), async (req, res) => {
  const { corridorId, amount, senderPhone, receiverPhone, customerPhone } = req.body ?? {};
  if (!senderPhone || !receiverPhone) return sendJson(res, 400, { error: "senderPhone and receiverPhone are required" });
  const result = await createExchangeOrder({
    corridorId, amountSent: Number(amount), senderPhone, receiverPhone, customerPhone,
    channel: "admin", adminId: req.auth!.sub,
  });
  if (result.error) return sendJson(res, result.status ?? 400, { error: result.error });
  sendJson(res, 201, result.order);
});

exchangeRouter.post("/agent/exchange/orders", requireAuth("agent"), async (req, res) => {
  const { corridorId, amount, senderPhone, receiverPhone, customerPhone } = req.body ?? {};
  if (!senderPhone || !receiverPhone) return sendJson(res, 400, { error: "senderPhone and receiverPhone are required" });
  const result = await createExchangeOrder({
    corridorId, amountSent: Number(amount), senderPhone, receiverPhone, customerPhone,
    channel: "agent", agentId: req.auth!.sub,
  });
  if (result.error) return sendJson(res, result.status ?? 400, { error: result.error });
  sendJson(res, 201, result.order);
});

// ---------------- Orders: list / detail ----------------

const EXCHANGE_ORDER_LIST_SELECT = `
  SELECT eo.*, c.phone AS customer_phone, c.name AS customer_name,
         fw.name AS from_wallet_name, tw.name AS to_wallet_name, a.name AS agent_name
  FROM exchange_orders eo
  LEFT JOIN customers c ON c.id = eo.customer_id
  LEFT JOIN payment_wallets fw ON fw.id = eo.from_wallet_id
  LEFT JOIN payment_wallets tw ON tw.id = eo.to_wallet_id
  LEFT JOIN agents a ON a.id = eo.agent_id
`;

exchangeRouter.get("/admin/exchange/orders", requireStaff(), async (req, res) => {
  const { status, corridorId, search, dateFrom, dateTo, limit, offset } = req.query as Record<string, string | undefined>;
  const args: unknown[] = [];
  let sql = `${EXCHANGE_ORDER_LIST_SELECT} WHERE 1=1`;
  if (status && EXCHANGE_ORDER_STATUSES.includes(status)) { args.push(status); sql += ` AND eo.status=$${args.length}`; }
  if (corridorId) { args.push(corridorId); sql += ` AND eo.corridor_id=$${args.length}`; }
  if (dateFrom) { args.push(dateFrom); sql += ` AND eo.created_at >= $${args.length}`; }
  if (dateTo) { args.push(dateTo); sql += ` AND eo.created_at <= $${args.length}`; }
  if (search) { args.push(`%${search}%`); sql += ` AND (eo.id ILIKE $${args.length} OR eo.sender_phone ILIKE $${args.length} OR eo.receiver_phone ILIKE $${args.length})`; }

  const cappedLimit = Math.min(Number(limit) || 200, 1000);
  args.push(cappedLimit);
  sql += ` ORDER BY eo.created_at DESC LIMIT $${args.length}`;
  if (offset) { args.push(Number(offset)); sql += ` OFFSET $${args.length}`; }
  sendJson(res, 200, await query(sql, args));
});

exchangeRouter.get("/admin/exchange/orders/:id", requireStaff(), async (req, res) => {
  const order = await queryOne(`${EXCHANGE_ORDER_LIST_SELECT} WHERE eo.id=$1`, [req.params.id]);
  if (!order) return sendJson(res, 404, { error: "Exchange order not found" });
  const dialAttempts = await query(
    `SELECT id, agent_id, sim_slot, attempt_number, step1_ussd_string, step1_response, step2_response, status, created_at, completed_at
     FROM exchange_dial_attempts WHERE exchange_order_id=$1 ORDER BY attempt_number`,
    [req.params.id]
  );
  sendJson(res, 200, { ...order, dialAttempts });
});

exchangeRouter.get("/agent/exchange/orders", requireAuth("agent"), async (req, res) => {
  // The agent's own payout queue — verified exchanges (in_progress) waiting
  // to be dialed, same shape as the customer app's order history but scoped
  // to what an agent needs to act on.
  sendJson(res, 200, await query(`${EXCHANGE_ORDER_LIST_SELECT} WHERE eo.status='in_progress' ORDER BY eo.created_at ASC`));
});

// ---------------- Verify (manual v1 — no SMS auto-matching) ----------------

exchangeRouter.post("/admin/exchange/orders/:id/verify", requirePermission("exchange.manage"), async (req, res) => {
  const result = await query(
    `UPDATE exchange_orders SET status='in_progress', updated_at=now() WHERE id=$1 AND status='pending' RETURNING id`,
    [req.params.id]
  );
  if (result.length === 0) {
    const existing = await queryOne(`SELECT status FROM exchange_orders WHERE id=$1`, [req.params.id]);
    if (!existing) return sendJson(res, 404, { error: "Exchange order not found" });
    return sendJson(res, 409, { error: `Cannot verify an order in status '${existing.status}'` });
  }
  await recordActivity({
    adminId: req.auth!.sub,
    action: "verify_exchange_order",
    entityType: "exchange_order",
    entityId: req.params.id,
    oldValue: { status: "pending" },
    newValue: { status: "in_progress" },
  });
  broadcast({ type: "exchange_order.updated", exchangeOrderId: req.params.id });
  sendJson(res, 200, await queryOne(`${EXCHANGE_ORDER_LIST_SELECT} WHERE eo.id=$1`, [req.params.id]));
});

// ---------------- Payout dial attempts (2-step USSD) ----------------
// Step 1: number+amount only, no PIN — "{dialPrefix}{receiverPhone}*{amountReceived}#".
// Step 2: the carrier prompts for a PIN; the PIN is returned to the agent
// device ONLY in this one response, for this one already-verified order,
// and is never written to any log, dial-attempt record, or UI (see Security
// section of the plan).

exchangeRouter.post("/agent/exchange/orders/:id/dial-attempts", requireAuth("agent"), async (req, res) => {
  const { attemptNumber } = req.body ?? {};
  const order = await queryOne<{ id: string; status: string; corridor_id: string; receiver_phone: string; amount_received: string }>(
    `SELECT id, status, corridor_id, receiver_phone, amount_received FROM exchange_orders WHERE id=$1`,
    [req.params.id]
  );
  if (!order) return sendJson(res, 404, { error: "Exchange order not found" });
  if (order.status !== "in_progress") {
    return sendJson(res, 409, { error: `Cannot dial a payout for an order in status '${order.status}'` });
  }

  const corridor = await loadCorridor(order.corridor_id);
  if (!corridor?.payout_wallet_id) {
    return sendJson(res, 409, { error: "This corridor has no payout wallet configured — ask a Super Admin to set one up." });
  }
  const payoutWallet = await loadPayoutWallet(corridor.payout_wallet_id);
  if (!payoutWallet?.pin_encrypted) {
    return sendJson(res, 409, { error: "This payout wallet has no PIN configured — ask a Super Admin to set one." });
  }
  const wallet = await queryOne<{ dial_prefix: string }>(`SELECT dial_prefix FROM payment_wallets WHERE id=$1`, [payoutWallet.wallet_id]);
  const dialPrefix = wallet?.dial_prefix ?? "";
  const step1UssdString = `${dialPrefix}${order.receiver_phone}*${order.amount_received}#`;

  const id = randomUUID();
  try {
    await query(
      `INSERT INTO exchange_dial_attempts (id, exchange_order_id, agent_id, sim_slot, attempt_number, step1_ussd_string, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [id, req.params.id, req.auth!.sub, payoutWallet.sim_slot, attemptNumber ?? 1, step1UssdString]
    );
  } catch (err: any) {
    if (err?.code !== "23505") throw err;
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM exchange_dial_attempts WHERE exchange_order_id=$1 AND attempt_number=$2`,
      [req.params.id, attemptNumber ?? 1]
    );
    return sendJson(res, 200, { id: existing!.id, step1UssdString, simSlot: payoutWallet.sim_slot });
  }

  // The one and only place the raw PIN ever leaves the server — scoped to
  // this specific authenticated agent's dial attempt for an already-verified
  // order, over HTTPS, held in the agent device's memory only.
  const pin = decrypt(payoutWallet.pin_encrypted);
  sendJson(res, 201, { id, step1UssdString, pin, simSlot: payoutWallet.sim_slot });
});

exchangeRouter.put("/agent/exchange/dial-attempts/:attemptId/step1", requireAuth("agent"), async (req, res) => {
  const { status, responseMessage } = req.body ?? {};
  if (!["step1_success", "failed", "ambiguous"].includes(status)) {
    return sendJson(res, 400, { error: "status must be step1_success, failed, or ambiguous" });
  }
  const result = await query(
    `UPDATE exchange_dial_attempts SET status=$1, step1_response=$2 WHERE id=$3 AND status='pending' RETURNING exchange_order_id`,
    [status, responseMessage ?? null, req.params.attemptId]
  );
  if (result.length === 0) {
    const existing = await queryOne(`SELECT * FROM exchange_dial_attempts WHERE id=$1`, [req.params.attemptId]);
    if (!existing) return sendJson(res, 404, { error: "Dial attempt not found" });
    return sendJson(res, 200, existing);
  }
  // A step-1 failure that's genuinely final fails the order the same way a
  // failed final Internet Store dial attempt does — no PIN was ever sent,
  // so there's nothing to reconcile.
  if (status !== "step1_success" && req.body.isFinalAttempt !== false) {
    await query(`UPDATE exchange_orders SET status='failed', updated_at=now() WHERE id=$1 AND status != 'completed'`, [result[0].exchange_order_id]);
    broadcast({ type: "exchange_order.updated", exchangeOrderId: result[0].exchange_order_id });
  }
  sendJson(res, 200, await queryOne(`SELECT * FROM exchange_dial_attempts WHERE id=$1`, [req.params.attemptId]));
});

exchangeRouter.put("/agent/exchange/dial-attempts/:attemptId/step2", requireAuth("agent"), async (req, res) => {
  const { status, responseMessage, isFinalAttempt } = req.body ?? {};
  if (!["success", "failed", "ambiguous"].includes(status)) {
    return sendJson(res, 400, { error: "status must be success, failed, or ambiguous" });
  }
  const finalAttempt = isFinalAttempt !== false;

  const attempt = await queryOne<{ id: string; exchange_order_id: string; status: string }>(
    `SELECT * FROM exchange_dial_attempts WHERE id=$1`,
    [req.params.attemptId]
  );
  if (!attempt) return sendJson(res, 404, { error: "Dial attempt not found" });

  // Re-derive the PIN transiently, purely to scrub it out of the carrier's
  // response text before storage — never itself stored or returned.
  let scrubbedMessage = responseMessage ?? null;
  const order = await queryOne<{ corridor_id: string }>(`SELECT corridor_id FROM exchange_orders WHERE id=$1`, [attempt.exchange_order_id]);
  if (order) {
    const corridor = await loadCorridor(order.corridor_id);
    const payoutWallet = corridor?.payout_wallet_id ? await loadPayoutWallet(corridor.payout_wallet_id) : null;
    if (payoutWallet?.pin_encrypted) {
      scrubbedMessage = scrubPin(scrubbedMessage, decrypt(payoutWallet.pin_encrypted));
    }
  }

  const result = await query(
    `UPDATE exchange_dial_attempts SET status=$1, step2_response=$2, completed_at=now() WHERE id=$3 AND status IN ('pending','step1_success') RETURNING exchange_order_id`,
    [status, scrubbedMessage, req.params.attemptId]
  );
  if (result.length === 0) {
    return sendJson(res, 200, await queryOne(`SELECT * FROM exchange_dial_attempts WHERE id=$1`, [req.params.attemptId]));
  }
  const exchangeOrderId = result[0].exchange_order_id as string;

  if (status === "success") {
    // Mark Completed only after a successful result — per the explicit
    // requirement. Atomic CAS so a duplicate/retried report can't double-fire.
    const completed = await query(
      `UPDATE exchange_orders SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1 AND status != 'completed' RETURNING *`,
      [exchangeOrderId]
    );
    if (completed.length > 0) {
      const eo = completed[0] as any;
      if (eo.customer_id) {
        try {
          await query(
            `INSERT INTO notifications (id, type, title, body, customer_id) VALUES ($1,'exchange_update',$2,$3,$4)`,
            [
              randomUUID(),
              "Your money exchange is complete",
              `Your exchange of ${eo.amount_sent} is complete — ${eo.receiver_phone} received ${eo.amount_received}.`,
              eo.customer_id,
            ]
          );
        } catch {
          // Best-effort — a notification failure must never fail the
          // already-completed exchange.
        }
      }
      await recordActivity({
        adminId: undefined,
        action: "exchange_completed",
        entityType: "exchange_order",
        entityId: exchangeOrderId,
        oldValue: null,
        newValue: { amountSent: eo.amount_sent, amountReceived: eo.amount_received, receiverPhone: eo.receiver_phone },
      });
    }
  } else if (finalAttempt) {
    await query(`UPDATE exchange_orders SET status='failed', updated_at=now() WHERE id=$1 AND status != 'completed'`, [exchangeOrderId]);
  }
  broadcast({ type: "exchange_order.updated", exchangeOrderId });
  sendJson(res, 200, await queryOne(`SELECT * FROM exchange_dial_attempts WHERE id=$1`, [req.params.attemptId]));
});

// ---------------- Reverse (pre-payout cancellation only) ----------------

exchangeRouter.post("/admin/exchange/orders/:id/reverse", requirePermission("exchange.manage"), async (req, res) => {
  const result = await query(
    `UPDATE exchange_orders SET status='cancelled', reversed_at=now(), updated_at=now() WHERE id=$1 AND status IN ('pending','in_progress') RETURNING id`,
    [req.params.id]
  );
  if (result.length === 0) {
    const existing = await queryOne(`SELECT status FROM exchange_orders WHERE id=$1`, [req.params.id]);
    if (!existing) return sendJson(res, 404, { error: "Exchange order not found" });
    return sendJson(res, 409, { error: `Cannot reverse an order in status '${existing.status}'` });
  }
  await recordActivity({
    adminId: req.auth!.sub,
    action: "reverse_exchange_order",
    entityType: "exchange_order",
    entityId: req.params.id,
    oldValue: null,
    newValue: { status: "cancelled" },
  });
  broadcast({ type: "exchange_order.updated", exchangeOrderId: req.params.id });
  sendJson(res, 200, await queryOne(`${EXCHANGE_ORDER_LIST_SELECT} WHERE eo.id=$1`, [req.params.id]));
});
