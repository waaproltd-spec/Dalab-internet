import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { encrypt, decrypt, isValidPin } from "../auth/crypto.js";
import { sendJson } from "../utils/camelCase.js";
import { broadcast } from "../realtime/orderEvents.js";
import { recordActivity } from "../utils/activityLog.js";
import { rateLimit } from "../auth/rateLimit.js";
import { notifyCustomer as notifyCustomerShared } from "../services/customerNotify.js";
import { validateMobileNumber } from "../lib/phoneValidation.js";
import { formatEvcDahabUssdAmount } from "../utils/ussdFormatting.js";

export const exchangeRouter = Router();

const EXCHANGE_ORDER_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"];

function exchangeOrderRef(): string {
  return "DEX" + Math.floor(100000000 + Math.random() * 900000000);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Same last-9-digit normalization orders.routes.ts/smsLogs.routes.ts use for
 * matching — Somali phone numbers legitimately appear with/without the 252
 * country code or a leading 0. Needed here (not just for matching) because
 * the carrier's own USSD payout menu rejects a receiver number dialed with
 * the 252 prefix still attached ("Please start the Number with 6XXXXXXXXX"),
 * expecting the bare 9-digit local number. */
function normalizePhone(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-9);
}

// Amount formatting for the *712*/*110* dial string moved to
// ussdFormatting.ts as formatEvcDahabUssdAmount() -- Shop and VIP Numbers
// dial the exact same EVC Plus/eDahab menus this flow does, so it's now
// the one shared implementation instead of a copy local to this file. See
// that function's own header comment for the live-confirmed carrier
// behavior this formula is based on.

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

// DALAB's own number for a given wallet TYPE (e.g. "here's our EVC Plus
// number, send your payment there") — deliberately reuses
// exchange_payout_wallets rather than a separate "collection numbers" table:
// per the settlement model, DALAB holds float in each wallet type and the
// same physical wallet a corridor might pay OUT of for one direction is
// exactly the number customers should pay INTO for the other direction.
// Picks the oldest configured wallet for that type if more than one exists.
async function loadCollectionPhoneNumber(walletId: string): Promise<string | null> {
  const row = await queryOne<{ phone_number: string }>(
    `SELECT phone_number FROM exchange_payout_wallets WHERE wallet_id=$1 ORDER BY created_at ASC LIMIT 1`,
    [walletId]
  );
  return row?.phone_number ?? null;
}

// Thin wrapper over the shared notifyCustomer (in-app notifications row +
// FCM push, both best-effort) that keeps every one of this file's existing
// call sites unchanged — they only ever needed (customerId, title, body).
async function notifyCustomer(customerId: string | null, title: string, body: string): Promise<void> {
  await notifyCustomerShared(customerId, "exchange_update", title, body);
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

// A corridor's payout wallet is what DALAB dials OUT of to pay the customer
// — it has to physically hold the "To" currency, not the "From" one (the
// dial prefix used at payout time comes from the payout wallet's own
// wallet_id — see POST /agent/exchange/orders/:id/dial-attempts). Enforced
// server-side, not just in the dashboard's dropdown, since the dashboard
// filter alone can't stop a direct/older API client from saving a
// mismatched pair.
async function validatePayoutWalletMatchesTo(
  payoutWalletId: string | null | undefined,
  toWalletId: string
): Promise<{ error?: string }> {
  if (!payoutWalletId) return {};
  const payoutWallet = await loadPayoutWallet(payoutWalletId);
  if (!payoutWallet) return { error: "Payout wallet not found" };
  if (payoutWallet.wallet_id !== toWalletId) {
    const [toWallet, payoutWalletKind] = await Promise.all([
      queryOne<{ name: string }>(`SELECT name FROM payment_wallets WHERE id=$1`, [toWalletId]),
      queryOne<{ name: string }>(`SELECT name FROM payment_wallets WHERE id=$1`, [payoutWallet.wallet_id]),
    ]);
    return {
      error: `Payout wallet must be a ${toWallet?.name ?? toWalletId} wallet (this corridor pays out in ${toWallet?.name ?? toWalletId}), but a ${payoutWalletKind?.name ?? payoutWallet.wallet_id} wallet was selected.`,
    };
  }
  return {};
}

exchangeRouter.post("/admin/exchange/corridors", requirePermission("exchange.manage"), async (req, res) => {
  const check = validateCorridorBody(req.body);
  if (check.error) return sendJson(res, 400, { error: check.error });
  const { fromWalletId, toWalletId, rate, feeType, feeValue, minAmount, maxAmount, payoutWalletId } = req.body;
  const payoutCheck = await validatePayoutWalletMatchesTo(payoutWalletId, toWalletId);
  if (payoutCheck.error) return sendJson(res, 400, { error: payoutCheck.error });

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
  const payoutCheck = await validatePayoutWalletMatchesTo(payoutWalletId, toWalletId);
  if (payoutCheck.error) return sendJson(res, 400, { error: payoutCheck.error });

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
  // Set directly for the Customer App's own authenticated create (the
  // customer IS req.auth.sub — no phone lookup needed); customerPhone
  // remains how admin/agent create on behalf of someone else.
  customerId?: string;
  channel: "admin" | "agent" | "customer_app";
  agentId?: string;
  adminId?: string;
  clientRequestId?: string | null;
  collectionPhoneNumber?: string | null;
}): Promise<{ error?: string; status?: number; order?: any }> {
  const corridor = await loadCorridor(params.corridorId);
  if (!corridor || !corridor.enabled) return { error: "Corridor not found or disabled", status: 404 };

  // senderPhone pays out of from_wallet_id, receiverPhone is paid into
  // to_wallet_id -- both are real payment_wallets.id values (evc_plus/
  // edahab/jeeb/amtel_pay), so this is an exact match, not a keyword guess.
  const senderCheck = validateMobileNumber(params.senderPhone, corridor.from_wallet_id);
  if (!senderCheck.valid) return { error: senderCheck.error, status: 400 };
  const receiverCheck = validateMobileNumber(params.receiverPhone, corridor.to_wallet_id);
  if (!receiverCheck.valid) return { error: receiverCheck.error, status: 400 };

  if (corridor.min_amount && params.amountSent < Number(corridor.min_amount)) {
    return { error: `Minimum amount for this corridor is ${corridor.min_amount}`, status: 400 };
  }
  if (corridor.max_amount && params.amountSent > Number(corridor.max_amount)) {
    return { error: `Maximum amount for this corridor is ${corridor.max_amount}`, status: 400 };
  }
  const { rate, fee, amountReceived } = computeQuote(params.amountSent, corridor);

  let customerId: string | null = params.customerId ?? null;
  if (customerId) {
    const customer = await queryOne<{ status: string }>(`SELECT status FROM customers WHERE id=$1`, [customerId]);
    if (!customer) return { error: "Customer not found", status: 404 };
    if (customer.status === "blocked") return { error: "This customer's account has been blocked", status: 403 };
  } else if (params.customerPhone) {
    let customer = await queryOne<{ id: string; status: string }>(`SELECT id, status FROM customers WHERE phone=$1`, [params.customerPhone]);
    if (!customer) {
      customer = await queryOne(`INSERT INTO customers (id, phone) VALUES ($1,$2) RETURNING id, status`, [randomUUID(), params.customerPhone]);
    }
    if (customer!.status === "blocked") return { error: "This customer's account has been blocked", status: 403 };
    customerId = customer!.id;
  }

  // Daily/monthly/yearly cumulative exchange limits (default $100/$500/$2000,
  // Admin-settable per customer via PUT /admin/customers/:id/exchange-limits
  // — see 047_exchange_wallet_lock_and_limits.sql). Only completed orders
  // count toward usage; calendar periods resolve in the DB session's
  // Africa/Mogadishu timezone (src/db/pool.ts). Admin-created orders
  // (channel: "admin") are exempt — an admin creating an order directly
  // already implies authorization, and raising a customer's limit is itself
  // an admin action.
  if (customerId && params.channel !== "admin") {
    const limits = await queryOne<{ daily: string; monthly: string; yearly: string }>(
      `SELECT COALESCE(exchange_daily_limit,100) AS daily,
              COALESCE(exchange_monthly_limit,500) AS monthly,
              COALESCE(exchange_yearly_limit,2000) AS yearly
       FROM customers WHERE id=$1`,
      [customerId]
    );
    const usage = await queryOne<{ daily_sum: string; monthly_sum: string; yearly_sum: string }>(
      `SELECT
         COALESCE(SUM(amount_sent) FILTER (WHERE completed_at >= date_trunc('day', now())), 0) AS daily_sum,
         COALESCE(SUM(amount_sent) FILTER (WHERE completed_at >= date_trunc('month', now())), 0) AS monthly_sum,
         COALESCE(SUM(amount_sent) FILTER (WHERE completed_at >= date_trunc('year', now())), 0) AS yearly_sum
       FROM exchange_orders WHERE customer_id=$1 AND status='completed'`,
      [customerId]
    );
    const checks: Array<[string, number, number]> = [
      ["daily", Number(usage!.daily_sum), Number(limits!.daily)],
      ["monthly", Number(usage!.monthly_sum), Number(limits!.monthly)],
      ["yearly", Number(usage!.yearly_sum), Number(limits!.yearly)],
    ];
    for (const [period, used, limit] of checks) {
      if (used + params.amountSent > limit) {
        return { error: `This would exceed your ${period} exchange limit of $${limit}. Contact support to request a higher limit.`, status: 400 };
      }
    }
  }

  const id = exchangeOrderRef();
  try {
    await query(
      `INSERT INTO exchange_orders
         (id, customer_id, corridor_id, from_wallet_id, to_wallet_id, amount_sent, rate_applied, fee_applied,
          amount_received, sender_phone, receiver_phone, channel, agent_id, created_by_admin_id, client_request_id, collection_phone_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id, customerId, corridor.id, corridor.from_wallet_id, corridor.to_wallet_id, params.amountSent, rate, fee,
        amountReceived, params.senderPhone, params.receiverPhone, params.channel, params.agentId ?? null, params.adminId ?? null,
        params.clientRequestId ?? null, params.collectionPhoneNumber ?? null,
      ]
    );
  } catch (err: any) {
    if (err?.code === "23505" && err?.constraint === "idx_exchange_orders_client_request_id" && params.clientRequestId) {
      // A retried create with the same clientRequestId (e.g. a double-tap or
      // a client retry after a dropped response) — the original attempt
      // already went through, so return that existing order instead of
      // creating a second one.
      const existing = await queryOne<{ id: string }>(`SELECT id FROM exchange_orders WHERE client_request_id=$1`, [params.clientRequestId]);
      return { order: await queryOne(`SELECT * FROM exchange_orders WHERE id=$1`, [existing!.id]) };
    }
    if (err?.code === "23505" && err?.constraint === "idx_exchange_orders_pending_content_dedup") {
      // Same customer already has a pending exchange order for this exact
      // corridor+amount (e.g. re-visiting Money Exchange without paying) —
      // reuse it instead of creating a duplicate sibling order that a future
      // payment SMS could otherwise complete instead of this one (see
      // 046_exchange_pending_dedup.sql).
      //
      // BUT this request's own sender/receiver phone and collection number
      // are what the customer just typed/was shown on THIS visit — stamp
      // them onto the reused row before returning it, same rationale as
      // orders.routes.ts's equivalent reuse path.
      const existing = await queryOne<{ id: string }>(
        `SELECT id FROM exchange_orders WHERE customer_id=$1 AND corridor_id=$2 AND amount_sent=$3 AND status='pending'`,
        [customerId, corridor.id, params.amountSent]
      );
      if (existing) {
        await query(
          `UPDATE exchange_orders SET sender_phone=$1, receiver_phone=$2, collection_phone_number=$3, updated_at=now()
           WHERE id=$4 AND status='pending'`,
          [params.senderPhone, params.receiverPhone, params.collectionPhoneNumber ?? null, existing.id]
        );
        return { order: await queryOne(`SELECT * FROM exchange_orders WHERE id=$1`, [existing.id]) };
      }
    }
    throw err;
  }
  const order = await queryOne(`SELECT * FROM exchange_orders WHERE id=$1`, [id]);
  broadcast({ type: "exchange_order.updated", exchangeOrderId: id });
  await notifyCustomer(
    customerId,
    "Codsiga sarrifka waa la helay",
    `Codsigaaga sarrifka ${params.amountSent} ayaa dib loo eegayaa. Waxaan ku ogeysiin doonaa marka lacag-bixintaada la xaqiijiyo.`
  );
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
  // to what an agent needs to act on. hasDialAttempt (not part of the
  // shared EXCHANGE_ORDER_LIST_SELECT — added here via a one-off EXISTS
  // subquery rather than mutating that shared constant) is what
  // ExchangeSelfHealSweeper checks before automatically starting a payout:
  // once ANY dial attempt exists for an order — success, failure, or
  // ambiguous — it must never be auto-dialed again, so a failed payout
  // stays Failed rather than silently getting retried and risking sending
  // the money twice.
  sendJson(
    res,
    200,
    await query(
      `SELECT eo.*, c.phone AS customer_phone, c.name AS customer_name,
              fw.name AS from_wallet_name, tw.name AS to_wallet_name, a.name AS agent_name,
              EXISTS(SELECT 1 FROM exchange_dial_attempts eda WHERE eda.exchange_order_id = eo.id) AS has_dial_attempt
       FROM exchange_orders eo
       LEFT JOIN customers c ON c.id = eo.customer_id
       LEFT JOIN payment_wallets fw ON fw.id = eo.from_wallet_id
       LEFT JOIN payment_wallets tw ON tw.id = eo.to_wallet_id
       LEFT JOIN agents a ON a.id = eo.agent_id
       WHERE eo.status='in_progress'
       ORDER BY eo.created_at ASC`
    )
  );
});

// ---------------- Verify ----------------
// v1 was manual-only ("no SMS auto-matching"); the matcher now exists
// (smsLogs.routes.ts's ingestPaymentSms/resweepUnmatchedSmsLogs), so this
// same pending->in_progress transition also fires automatically the moment
// an incoming payment SMS is matched to an order — see
// autoAdvanceExchangeOrderToInProgress below, which both this route and
// the SMS matcher call. Verifying only ever unblocks the payout step
// (Agent App's ExchangeSelfHealSweeper then picks up the resulting
// in_progress order); it never dials anything itself.

/**
 * Atomically moves an exchange order pending -> in_progress, logs it,
 * broadcasts the update, and notifies the customer — factored out of the
 * admin-facing verify route so the automatic SMS-match path can trigger
 * the exact same transition. Idempotent by construction: the UPDATE's
 * `AND status='pending'` guard means calling this twice for the same order
 * (e.g. a resweep racing the live SMS-upload path, or an admin manually
 * verifying an order the matcher already advanced) can never double-fire —
 * the second caller just gets the "not pending" error back.
 */
export async function autoAdvanceExchangeOrderToInProgress(
  orderId: string,
  opts: { adminId?: string; source: "admin" | "sms_match" }
): Promise<{ error?: string; status?: number; order?: any }> {
  const result = await query(
    `UPDATE exchange_orders SET status='in_progress', updated_at=now() WHERE id=$1 AND status='pending' RETURNING id, customer_id, amount_sent`,
    [orderId]
  );
  if (result.length === 0) {
    const existing = await queryOne(`SELECT status FROM exchange_orders WHERE id=$1`, [orderId]);
    if (!existing) return { error: "Exchange order not found", status: 404 };
    return { error: `Cannot verify an order in status '${existing.status}'`, status: 409 };
  }
  await recordActivity({
    adminId: opts.adminId,
    action: opts.source === "admin" ? "verify_exchange_order" : "auto_verify_exchange_order_sms_match",
    entityType: "exchange_order",
    entityId: orderId,
    oldValue: { status: "pending" },
    newValue: { status: "in_progress", source: opts.source },
  });
  broadcast({ type: "exchange_order.updated", exchangeOrderId: orderId });
  await notifyCustomer(
    result[0].customer_id,
    "Lacag-bixinta waa la xaqiijiyey",
    `Waxaan helnay lacag-bixintaada oo ah ${result[0].amount_sent} — sarrifkaaga hadda waa la farsamaynayaa.`
  );
  return { order: await queryOne(`${EXCHANGE_ORDER_LIST_SELECT} WHERE eo.id=$1`, [orderId]) };
}

exchangeRouter.post("/admin/exchange/orders/:id/verify", requirePermission("exchange.manage"), async (req, res) => {
  const result = await autoAdvanceExchangeOrderToInProgress(req.params.id, { adminId: req.auth!.sub, source: "admin" });
  if (result.error) return sendJson(res, result.status ?? 400, { error: result.error });
  sendJson(res, 200, result.order);
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
  // "*{dialPrefix}*{receiverPhone}*{dollars}*{cents}#" — e.g. EVC Plus
  // (dial_prefix "712"), $1.98 -> "*712*NUMBER*1*98#", eDahab (dial_prefix
  // "110"), $10.30 -> "*110*NUMBER*10*30#". receiverPhone must be the bare
  // local number — normalizePhone() strips any 252 country code / leading 0
  // the customer's saved number carries, since the carrier's menu rejects
  // anything but the 9-digit local form. The amount is dollars and cents as
  // separate *-delimited segments, not a "." decimal — see
  // formatEvcDahabUssdAmount() for why.
  const step1UssdString = `*${dialPrefix}*${normalizePhone(order.receiver_phone)}*${formatEvcDahabUssdAmount(order.amount_received)}#`;

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
    const failed = await query(
      `UPDATE exchange_orders SET status='failed', updated_at=now() WHERE id=$1 AND status != 'completed' RETURNING customer_id`,
      [result[0].exchange_order_id]
    );
    broadcast({ type: "exchange_order.updated", exchangeOrderId: result[0].exchange_order_id });
    if (failed.length > 0) {
      await notifyCustomer(failed[0].customer_id, "Sarrifku wuu fashilmay", "Ma awoodin inaan dhammaystirno sarrifkaaga. Fadlan la xiriir Taageerada si laguu caawiyo.");
    }
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
      await notifyCustomer(
        eo.customer_id,
        "Sarrifka lacagtaada waa la dhammaystiray",
        `Sarrifkaaga ${eo.amount_sent} waa la dhammaystiray — ${eo.receiver_phone} waxaa loo diray ${eo.amount_received}.`
      );
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
    const failed = await query(
      `UPDATE exchange_orders SET status='failed', updated_at=now() WHERE id=$1 AND status != 'completed' RETURNING customer_id`,
      [exchangeOrderId]
    );
    if (failed.length > 0) {
      await notifyCustomer(failed[0].customer_id, "Sarrifku wuu fashilmay", "Ma awoodin inaan dhammaystirno sarrifkaaga. Fadlan la xiriir Taageerada si laguu caawiyo.");
    }
  }
  broadcast({ type: "exchange_order.updated", exchangeOrderId });
  sendJson(res, 200, await queryOne(`SELECT * FROM exchange_dial_attempts WHERE id=$1`, [req.params.attemptId]));
});

// ---------------- Payout confirmation (carrier SMS corroboration) ----------------
// Mirrors orders.routes.ts's completeOrderById/POST /agent/orders/voucher-confirmation
// exactly (same shape, same "either signal can complete it first, the loser
// is a no-op" race handling) — the carrier's own outgoing-transfer SMS,
// arriving on the payout wallet's phone, as a second signal independent of
// ExchangeUssdOrchestrator's on-screen step2 classification. Deliberately
// also matches orders already marked 'failed', not just 'in_progress': the
// on-screen accessibility-based reading can misclassify a payout that
// genuinely went through as failed (confirmed live: order DEX176626979 --
// the carrier's SMS confirmed the transfer while the on-screen automation
// reported STEP2_FAILED because the PIN field hadn't rendered yet when the
// bridge's conflated event channel got a stray event). A stray/unmatched
// confirmation is not an error — nothing to complete just means this
// particular SMS doesn't correspond to a DALAB payout, or already did.

async function completeExchangeOrderByPayoutConfirmation(
  orderId: string,
  confirmationText: string
): Promise<{ order: any; success: boolean; alreadyCompleted: boolean } | null> {
  const order = await queryOne<{ id: string; status: string; customer_id: string | null; amount_sent: string; receiver_phone: string; amount_received: string }>(
    `SELECT * FROM exchange_orders WHERE id=$1`,
    [orderId]
  );
  if (!order) return null;

  const result = await query(
    `UPDATE exchange_orders SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1 AND status IN ('in_progress','failed') RETURNING *`,
    [orderId]
  );
  if (result.length === 0) {
    return { order, success: order.status === "completed", alreadyCompleted: order.status === "completed" };
  }
  const eo = result[0] as any;

  // Bring the most recent dial attempt's own record in line with reality too
  // — otherwise the admin dashboard would show a "completed" order sitting
  // next to a dial attempt still marked "failed", confusing any later audit.
  // Scrubs the PIN the same way the agent's own step2 report does.
  let scrubbedText = confirmationText;
  const corridor = await loadCorridor((order as any).corridor_id);
  const payoutWallet = corridor?.payout_wallet_id ? await loadPayoutWallet(corridor.payout_wallet_id) : null;
  if (payoutWallet?.pin_encrypted) {
    scrubbedText = scrubPin(scrubbedText, decrypt(payoutWallet.pin_encrypted)) ?? scrubbedText;
  }
  await query(
    `UPDATE exchange_dial_attempts SET status='success', step2_response=$1, completed_at=now()
     WHERE exchange_order_id=$2 AND status != 'success'
       AND attempt_number = (SELECT MAX(attempt_number) FROM exchange_dial_attempts WHERE exchange_order_id=$2)`,
    [scrubbedText, orderId]
  );

  await recordActivity({
    adminId: undefined,
    action: "exchange_completed_via_payout_sms",
    entityType: "exchange_order",
    entityId: orderId,
    oldValue: { status: order.status },
    newValue: { status: "completed", confirmationText: scrubbedText },
  });
  broadcast({ type: "exchange_order.updated", exchangeOrderId: orderId });
  if (eo.customer_id) {
    await notifyCustomer(
      eo.customer_id,
      "Sarrifka lacagtaada waa la dhammaystiray",
      `Sarrifkaaga ${eo.amount_sent} waa la dhammaystiray — ${eo.receiver_phone} waxaa loo diray ${eo.amount_received}.`
    );
  }
  return { order: eo, success: true, alreadyCompleted: false };
}

exchangeRouter.post("/agent/exchange/orders/payout-confirmation", requireAuth("agent"), async (req, res) => {
  const { receiverPhone, amount, rawText } = req.body ?? {};
  if (!receiverPhone || amount == null) {
    return sendJson(res, 400, { error: "receiverPhone and amount are required" });
  }
  const target = normalizePhone(receiverPhone);
  if (!target) return sendJson(res, 400, { error: "receiverPhone is not a valid phone number" });

  // Same simpler shape as Internet Store's voucher-confirmation route (no
  // device/SIM cross-check) — a payout wallet is dialed from exactly one
  // device by construction (exchange_payout_wallets.device_id), so an
  // amount+receiver-phone match is already specific enough in practice, and
  // completeExchangeOrderByPayoutConfirmation's atomic status guard is what
  // actually prevents a stray SMS from double-completing anything.
  const candidates = await withTransaction((client) =>
    client
      .query<{ id: string; receiver_phone: string | null }>(
        `SELECT id, receiver_phone FROM exchange_orders WHERE status IN ('in_progress','failed') AND ABS(amount_received - $1) < 0.01
         ORDER BY updated_at ASC
         FOR UPDATE SKIP LOCKED`,
        [amount]
      )
      .then((r) => r.rows)
  );
  const match = candidates.find((o) => normalizePhone(o.receiver_phone) === target);
  if (!match) return sendJson(res, 200, { matched: false });

  const result = await completeExchangeOrderByPayoutConfirmation(match.id, String(rawText ?? ""));
  sendJson(res, 200, { matched: true, orderId: match.id, alreadyCompleted: result?.alreadyCompleted ?? false });
});

// ---------------- Reverse (pre-payout cancellation only) ----------------

exchangeRouter.post("/admin/exchange/orders/:id/reverse", requirePermission("exchange.manage"), async (req, res) => {
  const result = await query(
    `UPDATE exchange_orders SET status='cancelled', reversed_at=now(), updated_at=now() WHERE id=$1 AND status IN ('pending','in_progress') RETURNING id, customer_id`,
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
  await notifyCustomer(result[0].customer_id, "Sarrifka waa la joojiyay", "Codsigaaga sarrifku waa la joojiyay. Haddii aad su'aalo qabto, fadlan la xiriir Taageerada.");
  sendJson(res, 200, await queryOne(`${EXCHANGE_ORDER_LIST_SELECT} WHERE eo.id=$1`, [req.params.id]));
});

// ==================== Customer App (self-service) ====================
// Public catalog reads (wallets/corridors/quote) mirror how GET /companies
// is public — no account needed to preview rates. Creating and viewing
// one's own exchange orders requires requireAuth("customer"), exactly like
// POST/GET /orders (Internet Store).

// dial_prefix is public/harmless to expose here — it's the same USSD
// carrier code (e.g. "712" for EVC Plus) the Customer App already builds
// Internet Store payment dial codes from via each company's ussdTemplate.
// The Customer App uses it to build the "Dial to Pay" USSD string for the
// customer's own collection-payment leg (see wallet_numbers/exchange_new/
// exchange_payment_instructions screens) — never anything payout/PIN
// related, which stays entirely server-side (exchange_payout_wallets).
exchangeRouter.get("/exchange/wallets", async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT id, name, provider_label, color_hex, logo_key, dial_prefix FROM payment_wallets WHERE enabled=true ORDER BY sort_order`
    )
  );
});

exchangeRouter.get("/exchange/corridors", async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT ec.id, ec.from_wallet_id, ec.to_wallet_id, ec.rate, ec.fee_type, ec.fee_value, ec.min_amount, ec.max_amount,
              fw.name AS from_wallet_name, tw.name AS to_wallet_name
       FROM exchange_corridors ec
       LEFT JOIN payment_wallets fw ON fw.id = ec.from_wallet_id
       LEFT JOIN payment_wallets tw ON tw.id = ec.to_wallet_id
       WHERE ec.enabled=true
       ORDER BY fw.sort_order, tw.sort_order`
    )
  );
});

exchangeRouter.get("/exchange/quote", handleQuote);

exchangeRouter.post(
  "/exchange/orders",
  requireAuth("customer"),
  rateLimit("customer-exchange-create", 20, 15 * 60 * 1000),
  async (req, res) => {
    const { corridorId, amount, senderPhone, receiverPhone, clientRequestId } = req.body ?? {};
    if (!senderPhone) return sendJson(res, 400, { error: "Provide a valid sending phone number" });
    if (!receiverPhone) return sendJson(res, 400, { error: "Provide a valid receiving phone number" });
    // Real format + carrier-prefix-vs-corridor-wallet validation happens
    // inside createExchangeOrder below (it knows the corridor's actual
    // from_wallet_id/to_wallet_id) -- this is just a presence check.
    if (clientRequestId != null && typeof clientRequestId !== "string") {
      return sendJson(res, 400, { error: "clientRequestId must be a string" });
    }

    const corridor = await loadCorridor(String(corridorId ?? ""));
    if (!corridor || !corridor.enabled) return sendJson(res, 404, { error: "This exchange corridor is not available" });

    // The customer app must be able to tell the customer exactly where to
    // send their payment — a corridor with no configured collection number
    // for its FROM currency isn't ready for self-checkout yet, even though
    // an admin/agent could still log the exchange manually on the customer's
    // behalf via the existing admin/agent endpoints.
    const collectionPhoneNumber = await loadCollectionPhoneNumber(corridor.from_wallet_id);
    if (!collectionPhoneNumber) {
      return sendJson(res, 409, { error: "This exchange isn't available for self-checkout yet — please contact support." });
    }

    const result = await createExchangeOrder({
      corridorId: corridor.id,
      amountSent: Number(amount),
      senderPhone: String(senderPhone),
      receiverPhone: String(receiverPhone),
      customerId: req.auth!.sub,
      channel: "customer_app",
      clientRequestId: clientRequestId ?? null,
      collectionPhoneNumber,
    });
    if (result.error) return sendJson(res, result.status ?? 400, { error: result.error });
    sendJson(res, 201, result.order);
  }
);

// Capped at 100 -- was unbounded; see orders.routes.ts's GET /orders for
// the same fix and reasoning.
exchangeRouter.get("/exchange/orders", requireAuth("customer"), async (req, res) => {
  sendJson(res, 200, await query(`${EXCHANGE_ORDER_LIST_SELECT} WHERE eo.customer_id=$1 ORDER BY eo.created_at DESC LIMIT 100`, [req.auth!.sub]));
});

exchangeRouter.get("/exchange/orders/:id", requireAuth("customer"), async (req, res) => {
  const order = await queryOne<{ id: string }>(`${EXCHANGE_ORDER_LIST_SELECT} WHERE eo.id=$1 AND eo.customer_id=$2`, [
    req.params.id,
    req.auth!.sub,
  ]);
  if (!order) return sendJson(res, 404, { error: "Exchange order not found" });
  // A payout attempt already under way (even if not yet resolved) is worth
  // surfacing distinctly from a plain "in_progress" — the Customer App uses
  // this to show "an agent is processing your exchange" instead of a
  // generic "payment confirmed, waiting" state. No dial-attempt internals
  // (USSD strings, carrier response text) are ever included here.
  const activeAttempt = await queryOne<{ id: string }>(
    `SELECT id FROM exchange_dial_attempts WHERE exchange_order_id=$1 LIMIT 1`,
    [req.params.id]
  );
  sendJson(res, 200, { ...order, payoutStarted: Boolean(activeAttempt) });
});
