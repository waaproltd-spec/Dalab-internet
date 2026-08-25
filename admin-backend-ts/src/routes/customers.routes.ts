import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { hashPassword, verifyPassword, isValidPin } from "../auth/crypto.js";
import { validateMobileNumber, companyKeyFromLabel } from "../lib/phoneValidation.js";

export const customersRouter = Router();

// pin_hash must never reach any client — explicit column list (plus a
// derived pinSet boolean) rather than SELECT *, same convention already
// used for pin_encrypted on companies.
//
// evc_plus_locked/edahab_locked and exchange_*_limit_effective/
// has_higher_exchange_limit are computed here rather than in application
// code so the Admin dashboard's list and single-customer responses always
// agree — see 047_exchange_wallet_lock_and_limits.sql and the wallet-lock/
// exchange-limits routes below for what these mean.
const ADMIN_CUSTOMER_COLUMNS = `id, phone, name, email, status, macaash_points, created_at,
  (pin_hash IS NOT NULL) AS pin_set, (password_hash IS NOT NULL) AS has_password,
  evc_plus_name, evc_plus_number, evc_plus_saved_at,
  (evc_plus_saved_at IS NOT NULL AND now() - evc_plus_saved_at > interval '2 hours') AS evc_plus_locked,
  edahab_name, edahab_number, edahab_saved_at,
  (edahab_saved_at IS NOT NULL AND now() - edahab_saved_at > interval '2 hours') AS edahab_locked,
  exchange_daily_limit, exchange_monthly_limit, exchange_yearly_limit,
  COALESCE(exchange_daily_limit, 100) AS exchange_daily_limit_effective,
  COALESCE(exchange_monthly_limit, 500) AS exchange_monthly_limit_effective,
  COALESCE(exchange_yearly_limit, 2000) AS exchange_yearly_limit_effective,
  ((exchange_daily_limit IS NOT NULL AND exchange_daily_limit > 100)
    OR (exchange_monthly_limit IS NOT NULL AND exchange_monthly_limit > 500)
    OR (exchange_yearly_limit IS NOT NULL AND exchange_yearly_limit > 2000)) AS has_higher_exchange_limit`;

// Shared by both the customer's own PUT /customer/wallet-numbers and the
// Admin override PUT /admin/customers/:id/wallet-numbers below — a wallet
// (EVC Plus, eDahab) is always a name+number pair, saved and cleared
// together (047_exchange_wallet_lock_and_limits.sql).
const WALLET_PHONE_RE = /^\+?\d{6,15}$/;
const WALLET_LOCK_WINDOW_MS = 2 * 60 * 60 * 1000;
function walletPairError(label: string) {
  return { error: `Provide both a name and a number for ${label}, or clear both` };
}

customersRouter.get("/admin/customers", requireStaff(), async (req, res) => {
  const { search } = req.query;
  const rows = search
    ? await query(`SELECT ${ADMIN_CUSTOMER_COLUMNS} FROM customers WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY created_at DESC`, [`%${search}%`])
    : await query(`SELECT ${ADMIN_CUSTOMER_COLUMNS} FROM customers ORDER BY created_at DESC`);
  sendJson(res, 200, rows);
});

customersRouter.put("/admin/customers/:id", requirePermission("customers.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM customers WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Customer not found" });
  const name = req.body.name ?? existing.name;
  const phone = req.body.phone ?? existing.phone;
  if (phone !== existing.phone && (await queryOne(`SELECT id FROM customers WHERE phone=$1`, [phone]))) {
    return sendJson(res, 409, { error: "A customer with this phone already exists" });
  }
  await query(`UPDATE customers SET name=$1, phone=$2 WHERE id=$3`, [name, phone, req.params.id]);
  sendJson(res, 200, await queryOne(`SELECT ${ADMIN_CUSTOMER_COLUMNS} FROM customers WHERE id=$1`, [req.params.id]));
});

customersRouter.put("/admin/customers/:id/block", requirePermission("customers.manage"), async (req, res) => {
  const customer = await queryOne(`SELECT * FROM customers WHERE id=$1`, [req.params.id]);
  if (!customer) return sendJson(res, 404, { error: "Customer not found" });
  const nextStatus = customer.status === "active" ? "blocked" : "active";
  await query(`UPDATE customers SET status=$1 WHERE id=$2`, [nextStatus, req.params.id]);
  sendJson(res, 200, await queryOne(`SELECT ${ADMIN_CUSTOMER_COLUMNS} FROM customers WHERE id=$1`, [req.params.id]));
});

// ---------------- Customer wallet info override (Admin) ----------------
// The customer-facing PUT /customer/wallet-numbers (below) locks a wallet 2
// hours after it's first saved — this is the only way to correct one after
// that, and the only way (unlockEvcPlus/unlockEdahab) to grant the customer
// a fresh self-service window again. No lock check here — an Admin can
// always edit.
customersRouter.put("/admin/customers/:id/wallet-numbers", requirePermission("customers.manage"), async (req, res) => {
  const existing = await queryOne<{
    evc_plus_name: string | null;
    evc_plus_number: string | null;
    evc_plus_saved_at: string | null;
    edahab_name: string | null;
    edahab_number: string | null;
    edahab_saved_at: string | null;
  }>(
    `SELECT evc_plus_name, evc_plus_number, evc_plus_saved_at, edahab_name, edahab_number, edahab_saved_at FROM customers WHERE id=$1`,
    [req.params.id]
  );
  if (!existing) return sendJson(res, 404, { error: "Customer not found" });
  const body = req.body ?? {};

  for (const field of ["evcPlusNumber", "edahabNumber"] as const) {
    if (field in body && body[field] != null && !WALLET_PHONE_RE.test(String(body[field]))) {
      return sendJson(res, 400, { error: `Provide a valid ${field === "evcPlusNumber" ? "EVC Plus" : "eDahab"} number` });
    }
  }

  const touchesEvc = "evcPlusName" in body || "evcPlusNumber" in body;
  const touchesEdahab = "edahabName" in body || "edahabNumber" in body;

  const evcPlusName = "evcPlusName" in body ? (body.evcPlusName == null ? null : String(body.evcPlusName).trim()) : existing.evc_plus_name;
  const evcPlusNumber = "evcPlusNumber" in body ? (body.evcPlusNumber == null ? null : String(body.evcPlusNumber)) : existing.evc_plus_number;
  const edahabName = "edahabName" in body ? (body.edahabName == null ? null : String(body.edahabName).trim()) : existing.edahab_name;
  const edahabNumber = "edahabNumber" in body ? (body.edahabNumber == null ? null : String(body.edahabNumber)) : existing.edahab_number;

  // Only validate the pair on a wallet this request actually touches — a
  // customer/admin editing just one wallet shouldn't get blocked by the
  // OTHER wallet's pre-existing state (e.g. a bare number saved before
  // 047_exchange_wallet_lock_and_limits.sql added the name column, leaving
  // name=null/number=set on a wallet nobody's touched through this pair
  // flow yet).
  if (touchesEvc && (evcPlusName == null) !== (evcPlusNumber == null)) return sendJson(res, 400, walletPairError("EVC Plus"));
  if (touchesEdahab && (edahabName == null) !== (edahabNumber == null)) return sendJson(res, 400, walletPairError("eDahab"));

  let evcPlusSavedAt = evcPlusName != null && evcPlusNumber != null ? existing.evc_plus_saved_at : null;
  let edahabSavedAt = edahabName != null && edahabNumber != null ? existing.edahab_saved_at : null;
  if (body.unlockEvcPlus === true && evcPlusName != null) evcPlusSavedAt = new Date().toISOString();
  if (body.unlockEdahab === true && edahabName != null) edahabSavedAt = new Date().toISOString();

  await query(
    `UPDATE customers SET evc_plus_name=$1, evc_plus_number=$2, evc_plus_saved_at=$3, edahab_name=$4, edahab_number=$5, edahab_saved_at=$6 WHERE id=$7`,
    [evcPlusName, evcPlusNumber, evcPlusSavedAt, edahabName, edahabNumber, edahabSavedAt, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT ${ADMIN_CUSTOMER_COLUMNS} FROM customers WHERE id=$1`, [req.params.id]));
});

// ---------------- Customer exchange limits (Admin) ----------------
// NULL reverts a period to the platform default (see exchange.routes.ts's
// createExchangeOrder for enforcement) — a number here is a custom limit for
// this one customer. has_higher_exchange_limit (ADMIN_CUSTOMER_COLUMNS) only
// turns on when a custom value actually exceeds its default, so the
// dashboard's blue checkmark means "approved for more," not just "has an
// override configured."
customersRouter.put("/admin/customers/:id/exchange-limits", requirePermission("customers.manage"), async (req, res) => {
  const existing = await queryOne<{ exchange_daily_limit: string | null; exchange_monthly_limit: string | null; exchange_yearly_limit: string | null }>(
    `SELECT exchange_daily_limit, exchange_monthly_limit, exchange_yearly_limit FROM customers WHERE id=$1`,
    [req.params.id]
  );
  if (!existing) return sendJson(res, 404, { error: "Customer not found" });
  const body = req.body ?? {};

  for (const field of ["dailyLimit", "monthlyLimit", "yearlyLimit"] as const) {
    if (field in body && body[field] != null && !(Number.isFinite(Number(body[field])) && Number(body[field]) > 0)) {
      return sendJson(res, 400, { error: `${field} must be a positive number or null` });
    }
  }

  const dailyLimit = "dailyLimit" in body ? (body.dailyLimit == null ? null : Number(body.dailyLimit)) : existing.exchange_daily_limit;
  const monthlyLimit = "monthlyLimit" in body ? (body.monthlyLimit == null ? null : Number(body.monthlyLimit)) : existing.exchange_monthly_limit;
  const yearlyLimit = "yearlyLimit" in body ? (body.yearlyLimit == null ? null : Number(body.yearlyLimit)) : existing.exchange_yearly_limit;

  await query(
    `UPDATE customers SET exchange_daily_limit=$1, exchange_monthly_limit=$2, exchange_yearly_limit=$3 WHERE id=$4`,
    [dailyLimit, monthlyLimit, yearlyLimit, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT ${ADMIN_CUSTOMER_COLUMNS} FROM customers WHERE id=$1`, [req.params.id]));
});

// ---------------- Customer PIN management (Super Admin only) ----------------
// Deliberately requireAuth("super_admin") rather than requirePermission(...)
// — unlike every other customers.manage action, this is not delegable to a
// regular Admin no matter what permissions the Super Admin grants them, per
// explicit requirement. The PIN itself is bcrypt-hashed (same as admin
// passwords) and never returned to any client — only whether one is set.
// This stays the path for a customer who's locked out (forgot their PIN) —
// Support directs them to a Super Admin here. Self-service create/verify for
// a customer who still has access to their own account is a separate,
// later-added set of routes below ("Customer: own profile" section), which
// operate on this same pin_hash column but never touch the OTP login flow.
customersRouter.get("/admin/customers/:id/pin-status", requireAuth("super_admin"), async (req, res) => {
  const customer = await queryOne<{ pin_hash: string | null }>(`SELECT pin_hash FROM customers WHERE id=$1`, [req.params.id]);
  if (!customer) return sendJson(res, 404, { error: "Customer not found" });
  sendJson(res, 200, { isSet: Boolean(customer.pin_hash) });
});

// Same handler covers both "create" and "change" — a PIN either isn't set
// yet or already is; setting a new value works identically either way.
customersRouter.put("/admin/customers/:id/pin", requireAuth("super_admin"), async (req, res) => {
  const { pin } = req.body;
  if (!isValidPin(String(pin ?? ""))) return sendJson(res, 400, { error: "PIN must be 4-8 digits" });
  const existing = await queryOne(`SELECT id FROM customers WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Customer not found" });
  const pinHash = await hashPassword(String(pin));
  await query(`UPDATE customers SET pin_hash=$1 WHERE id=$2`, [pinHash, req.params.id]);
  sendJson(res, 200, { message: "PIN saved", isSet: true });
});

// "Reset" clears the PIN back to unset (optional) rather than assigning a
// new one itself — the customer/Support flow that lets them "create a new
// PIN" afterward is a separate, later concern; this just guarantees the old
// PIN can never be used again.
customersRouter.delete("/admin/customers/:id/pin", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM customers WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Customer not found" });
  await query(`UPDATE customers SET pin_hash=NULL WHERE id=$1`, [req.params.id]);
  sendJson(res, 200, { message: "PIN reset", isSet: false });
});

// ---------------- Customer password reset (Super Admin only) ----------------
// There's no self-service "forgot password" flow — no email/SMS gateway is
// wired up to deliver a reset link/code to the customer directly (same
// reasoning as the PIN reset above). Support directs a locked-out customer
// here instead: a Super Admin generates a fresh temporary password and
// relays it out-of-band (phone call, WhatsApp, etc.); the customer is
// expected to change it from inside the app afterward. Returned in the
// response exactly once — never stored or logged in plaintext anywhere,
// same pattern the old test-mode OTP/admin-reset-token stand-ins used
// before this had a real out-of-band channel to rely on.
function generateTempPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

customersRouter.put("/admin/customers/:id/reset-password", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM customers WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Customer not found" });
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  await query(`UPDATE customers SET password_hash=$1 WHERE id=$2`, [passwordHash, req.params.id]);
  sendJson(res, 200, { message: "Password reset", tempPassword });
});

// Blocked by ON DELETE RESTRICT from orders if the customer has order
// history — surfaced as a friendly 409 suggesting block instead, since a
// hard delete there would corrupt receipts/reports.
customersRouter.delete("/admin/customers/:id", requirePermission("customers.manage"), async (req, res) => {
  try {
    const result = await query(`DELETE FROM customers WHERE id=$1 RETURNING id`, [req.params.id]);
    if (result.length === 0) return sendJson(res, 404, { error: "Customer not found" });
    sendJson(res, 200, { deleted: true });
  } catch (err: any) {
    if (err?.code === "23503") {
      return sendJson(res, 409, {
        error: "This customer has existing orders and can't be deleted. Disable the account instead.",
      });
    }
    throw err;
  }
});

// ---------------- Agent: customer lookup (for walk-in sales) ----------------
// pin_encrypted/password fields don't exist on customers, but explicit
// column list still keeps this in sync with what the Agent App actually needs.
const AGENT_CUSTOMER_COLUMNS = "id, phone, name, status, macaash_points, created_at";

customersRouter.get("/agent/customers", requireAuth("agent"), async (req, res) => {
  const { search } = req.query;
  const rows = search
    ? await query(
        `SELECT ${AGENT_CUSTOMER_COLUMNS} FROM customers WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY created_at DESC`,
        [`%${search}%`]
      )
    : await query(`SELECT ${AGENT_CUSTOMER_COLUMNS} FROM customers ORDER BY created_at DESC`);
  sendJson(res, 200, rows);
});

customersRouter.post("/agent/customers", requireAuth("agent"), async (req, res) => {
  const phone = String(req.body.phone ?? "").trim();
  if (!/^\+?\d{6,15}$/.test(phone)) return sendJson(res, 400, { error: "Provide a valid phone number" });
  const name = req.body.name ? String(req.body.name).trim() : null;

  const existing = await queryOne(`SELECT ${AGENT_CUSTOMER_COLUMNS} FROM customers WHERE phone=$1`, [phone]);
  if (existing) return sendJson(res, 409, { error: "A customer with this phone already exists", customer: existing });

  const id = randomUUID();
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,$3)`, [id, phone, name]);
  sendJson(res, 201, await queryOne(`SELECT ${AGENT_CUSTOMER_COLUMNS} FROM customers WHERE id=$1`, [id]));
});

// ---------------- Customer: own profile ----------------
const CUSTOMER_PROFILE_COLUMNS =
  "id, phone, name, email, macaash_points, evc_plus_name, evc_plus_number, evc_plus_saved_at, edahab_name, edahab_number, edahab_saved_at, created_at";

customersRouter.get("/customer/profile", requireAuth("customer"), async (req, res) => {
  const customer = await queryOne(`SELECT ${CUSTOMER_PROFILE_COLUMNS} FROM customers WHERE id=$1`, [req.auth!.sub]);
  if (!customer) return sendJson(res, 404, { error: "Customer not found" });
  sendJson(res, 200, customer);
});

customersRouter.put("/customer/profile", requireAuth("customer"), async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) return sendJson(res, 400, { error: "name is required" });
  await query(`UPDATE customers SET name=$1 WHERE id=$2`, [name, req.auth!.sub]);
  sendJson(res, 200, await queryOne(`SELECT ${CUSTOMER_PROFILE_COLUMNS} FROM customers WHERE id=$1`, [req.auth!.sub]));
});

// ---------------- Customer: saved Money Exchange wallet numbers ----------------
// So Money Exchange can auto-fill sender/receiver numbers from the
// customer's own Account instead of asking them to retype both every time
// (see exchange.routes.ts and the Customer App's exchange_swap_screen.dart /
// wallet_numbers_screen.dart). Each wallet (EVC Plus, eDahab) is a name+
// number pair, saved and cleared together — explicitly passing null for
// both (as opposed to omitting the keys) clears that wallet, only while
// it's still unlocked. A wallet locks a fixed 2 hours after it's first
// saved (evc_plus_saved_at/edahab_saved_at, set once and never refreshed by
// a later edit within the window); past that, only PUT /admin/customers/:id/
// wallet-numbers can change or unlock it.
customersRouter.put("/customer/wallet-numbers", requireAuth("customer"), async (req, res) => {
  const body = req.body ?? {};
  for (const field of ["evcPlusNumber", "edahabNumber"] as const) {
    if (field in body && body[field] != null && !WALLET_PHONE_RE.test(String(body[field]))) {
      return sendJson(res, 400, { error: `Provide a valid ${field === "evcPlusNumber" ? "EVC Plus" : "eDahab"} number` });
    }
  }
  const existing = await queryOne<{
    evc_plus_name: string | null;
    evc_plus_number: string | null;
    evc_plus_saved_at: string | null;
    edahab_name: string | null;
    edahab_number: string | null;
    edahab_saved_at: string | null;
  }>(
    `SELECT evc_plus_name, evc_plus_number, evc_plus_saved_at, edahab_name, edahab_number, edahab_saved_at FROM customers WHERE id=$1`,
    [req.auth!.sub]
  );
  if (!existing) return sendJson(res, 404, { error: "Customer not found" });

  const touchesEvc = "evcPlusName" in body || "evcPlusNumber" in body;
  const touchesEdahab = "edahabName" in body || "edahabNumber" in body;
  const evcLocked = existing.evc_plus_saved_at != null && Date.now() - new Date(existing.evc_plus_saved_at).getTime() > WALLET_LOCK_WINDOW_MS;
  const edahabLocked = existing.edahab_saved_at != null && Date.now() - new Date(existing.edahab_saved_at).getTime() > WALLET_LOCK_WINDOW_MS;
  if (touchesEvc && evcLocked) return sendJson(res, 403, { error: "Your EVC Plus wallet info is locked. Contact support to update it." });
  if (touchesEdahab && edahabLocked) return sendJson(res, 403, { error: "Your eDahab wallet info is locked. Contact support to update it." });

  const evcPlusName = "evcPlusName" in body ? (body.evcPlusName == null ? null : String(body.evcPlusName).trim()) : existing.evc_plus_name;
  const evcPlusNumber = "evcPlusNumber" in body ? (body.evcPlusNumber == null ? null : String(body.evcPlusNumber)) : existing.evc_plus_number;
  const edahabName = "edahabName" in body ? (body.edahabName == null ? null : String(body.edahabName).trim()) : existing.edahab_name;
  const edahabNumber = "edahabNumber" in body ? (body.edahabNumber == null ? null : String(body.edahabNumber)) : existing.edahab_number;

  // Only validate the pair on a wallet this request actually touches — a
  // customer who saved a bare number before the name field existed
  // (044_customer_wallet_numbers.sql predates 047's name columns) can have
  // name=null/number=set on the OTHER wallet, one nobody's edited through
  // this pair flow yet. Re-validating that untouched, pre-existing state on
  // every save incorrectly blocked saving a wallet that was actually
  // complete and correct.
  if (touchesEvc && (evcPlusName == null) !== (evcPlusNumber == null)) return sendJson(res, 400, walletPairError("EVC Plus"));
  if (touchesEdahab && (edahabName == null) !== (edahabNumber == null)) return sendJson(res, 400, walletPairError("eDahab"));

  const evcPlusSavedAt = evcPlusName != null && evcPlusNumber != null ? (existing.evc_plus_saved_at ?? new Date().toISOString()) : null;
  const edahabSavedAt = edahabName != null && edahabNumber != null ? (existing.edahab_saved_at ?? new Date().toISOString()) : null;

  await query(
    `UPDATE customers SET evc_plus_name=$1, evc_plus_number=$2, evc_plus_saved_at=$3, edahab_name=$4, edahab_number=$5, edahab_saved_at=$6 WHERE id=$7`,
    [evcPlusName, evcPlusNumber, evcPlusSavedAt, edahabName, edahabNumber, edahabSavedAt, req.auth!.sub]
  );
  sendJson(res, 200, await queryOne(`SELECT ${CUSTOMER_PROFILE_COLUMNS} FROM customers WHERE id=$1`, [req.auth!.sub]));
});

// ---------------- Customer: Offline Auto-Order profile ----------------
// A completely separate configuration path from Online ordering (see
// orders.routes.ts's POST /orders) — Online sender/destination numbers are
// entered per-order and never read or write anything here (spec requirement
// 19). This is the customer's own standing "no internet, just send the
// payment" setup — sender number, destination number, Company, and
// Package — saved together from one screen and reused by every future
// automatic Offline order (offlineAutoOrder.ts's matchOrCreateOfflineAutoOrder)
// until edited again. Admin never configures an individual customer's
// Offline Profile (spec requirement 4) — only the catalog it's built from:
// companies/packages/prices/payment numbers, via companies.routes.ts.
const OFFLINE_PROFILE_COLUMNS =
  "offline_sender_number, offline_destination_number, offline_company_id, offline_package_id, offline_profile_updated_at";

async function serializeOfflineProfile(customerId: string) {
  const row = await queryOne<{
    offline_sender_number: string | null;
    offline_destination_number: string | null;
    offline_company_id: string | null;
    offline_package_id: string | null;
    offline_profile_updated_at: string | null;
  }>(`SELECT ${OFFLINE_PROFILE_COLUMNS} FROM customers WHERE id=$1`, [customerId]);
  if (!row) return null;
  // The authoritative price always comes from the package row itself, never
  // stored redundantly on the customer (spec requirement 5) — a later admin
  // price change is reflected here automatically, and offlineAutoOrder.ts
  // reads the same live package.price at match time, never a snapshot.
  const company = row.offline_company_id ? await queryOne(`SELECT id, name, color_hex, logo_url FROM companies WHERE id=$1`, [row.offline_company_id]) : null;
  const pkg = row.offline_package_id
    ? await queryOne(
        `SELECT id, company_id, category_id, name, old_price, price, mb, minutes, sms, validity FROM packages WHERE id=$1`,
        [row.offline_package_id]
      )
    : null;
  return {
    senderNumber: row.offline_sender_number,
    destinationNumber: row.offline_destination_number,
    company,
    package: pkg,
    updatedAt: row.offline_profile_updated_at,
  };
}

customersRouter.get("/customer/offline-profile", requireAuth("customer"), async (req, res) => {
  const profile = await serializeOfflineProfile(req.auth!.sub);
  if (!profile) return sendJson(res, 404, { error: "Customer not found" });
  sendJson(res, 200, profile);
});

// All four fields are saved together, every time — Company and Package are
// coupled (a package must belong to the chosen company), and the whole
// point of one screen with one Save button (spec requirement 2/18) is that
// there's no intermediate, partially-configured profile to reason about.
// Price is never accepted from the client (spec requirement 5/16) — it's
// always read back from the package the customer picked, here and again at
// match time.
customersRouter.put("/customer/offline-profile", requireAuth("customer"), async (req, res) => {
  const { senderNumber, destinationNumber, companyId, packageId } = req.body ?? {};
  if (!senderNumber || !destinationNumber || !companyId || !packageId) {
    return sendJson(res, 400, { error: "senderNumber, destinationNumber, companyId, and packageId are all required" });
  }

  const company = await queryOne<{ id: string; name: string; status: string }>(
    `SELECT id, name, status FROM companies WHERE id=$1 AND deleted_at IS NULL`,
    [companyId]
  );
  if (!company) return sendJson(res, 404, { error: "Company not found" });
  if (company.status === "offline") return sendJson(res, 409, { error: `${company.name} is currently offline` });

  const pkg = await queryOne<{ id: string; company_id: string }>(`SELECT id, company_id FROM packages WHERE id=$1 AND active=true`, [packageId]);
  if (!pkg) return sendJson(res, 404, { error: "Package not found" });
  if (pkg.company_id !== companyId) return sendJson(res, 400, { error: "Package does not belong to the selected company" });

  // Sender: any known carrier accepted, same as Online's optional senderPhone
  // (no specific payment method to narrow it to — Offline Profile only
  // saves a Company, not a specific EVC Plus/eDahab/... method within it).
  const senderCheck = validateMobileNumber(String(senderNumber));
  if (!senderCheck.valid) return sendJson(res, 400, { error: senderCheck.error });
  // Destination: must belong to the selected company's own carrier, same
  // rule Online's receiverPhone already enforces.
  const destinationCheck = validateMobileNumber(String(destinationNumber), companyKeyFromLabel(company.name));
  if (!destinationCheck.valid) return sendJson(res, 400, { error: destinationCheck.error });

  await query(
    `UPDATE customers SET offline_sender_number=$1, offline_destination_number=$2, offline_company_id=$3, offline_package_id=$4, offline_profile_updated_at=now() WHERE id=$5`,
    [String(senderNumber), String(destinationNumber), companyId, packageId, req.auth!.sub]
  );
  sendJson(res, 200, await serializeOfflineProfile(req.auth!.sub));
});

customersRouter.delete("/customer/offline-profile", requireAuth("customer"), async (req, res) => {
  await query(
    `UPDATE customers SET offline_sender_number=NULL, offline_destination_number=NULL, offline_company_id=NULL, offline_package_id=NULL, offline_profile_updated_at=NULL WHERE id=$1`,
    [req.auth!.sub]
  );
  sendJson(res, 200, { ok: true });
});

// Same ON DELETE RESTRICT constraint as the admin delete route — a customer
// with existing orders can't be hard-deleted without corrupting receipts/
// reports, surfaced as a friendly 409 rather than a raw constraint error.
customersRouter.delete("/customer/profile", requireAuth("customer"), async (req, res) => {
  try {
    await query(`DELETE FROM customers WHERE id=$1`, [req.auth!.sub]);
    sendJson(res, 200, { deleted: true });
  } catch (err: any) {
    if (err?.code === "23503") {
      return sendJson(res, 409, {
        error: "Your account has existing orders and can't be deleted. Please contact support.",
      });
    }
    throw err;
  }
});

// ---------------- Customer: optional self-service login PIN ----------------
// Entirely additive, on the same pin_hash column the Super Admin routes above
// manage. Optional by design: a customer with no PIN set is completely
// unaffected — /auth/login already reports pinSet=false and the app skips
// straight past any PIN prompt. Setting one here is the customer choosing to
// add a lightweight extra step of their own accord; the password login flow
// itself (phone/email + password -> tokens) is never touched by any of this.
customersRouter.get("/customer/pin-status", requireAuth("customer"), async (req, res) => {
  const customer = await queryOne<{ pin_hash: string | null }>(`SELECT pin_hash FROM customers WHERE id=$1`, [req.auth!.sub]);
  if (!customer) return sendJson(res, 404, { error: "Customer not found" });
  sendJson(res, 200, { isSet: Boolean(customer.pin_hash) });
});

// Same handler covers both "create" (no pin_hash yet — the auth token alone
// is proof of ownership) and "change" (a pin_hash already exists — also
// requires currentPin, matching the Profile "Change PIN" UX rather than
// letting a bare access token silently take over an already-PIN-protected
// account).
customersRouter.put("/customer/pin", requireAuth("customer"), async (req, res) => {
  const { pin, currentPin } = req.body;
  if (!isValidPin(String(pin ?? ""))) return sendJson(res, 400, { error: "PIN must be 4-8 digits" });

  const customer = await queryOne<{ pin_hash: string | null }>(`SELECT pin_hash FROM customers WHERE id=$1`, [req.auth!.sub]);
  if (!customer) return sendJson(res, 404, { error: "Customer not found" });
  if (customer.pin_hash) {
    if (!(await verifyPassword(String(currentPin ?? ""), customer.pin_hash))) {
      return sendJson(res, 401, { error: "Current PIN is incorrect" });
    }
  }

  const pinHash = await hashPassword(String(pin));
  await query(`UPDATE customers SET pin_hash=$1 WHERE id=$2`, [pinHash, req.auth!.sub]);
  sendJson(res, 200, { message: "PIN saved", isSet: true });
});

// Lets a customer opt back out entirely — after this, pinSet is false again
// and the app stops prompting for a PIN on future logins, same as if they
// had never created one.
customersRouter.delete("/customer/pin", requireAuth("customer"), async (req, res) => {
  await query(`UPDATE customers SET pin_hash=NULL WHERE id=$1`, [req.auth!.sub]);
  sendJson(res, 200, { message: "PIN removed", isSet: false });
});

// Called right after login (using the token /auth/login already issued) to
// check the PIN the customer just typed — this is a UX gate on top of an
// already-fully-authenticated session, not a second factor that blocks
// token issuance; a wrong PIN here never invalidates the tokens.
customersRouter.post("/customer/pin/verify", requireAuth("customer"), async (req, res) => {
  const customer = await queryOne<{ pin_hash: string | null }>(`SELECT pin_hash FROM customers WHERE id=$1`, [req.auth!.sub]);
  if (!customer) return sendJson(res, 404, { error: "Customer not found" });
  if (!customer.pin_hash) return sendJson(res, 200, { valid: true }); // nothing to verify against — treat as pass-through
  const pin = String(req.body.pin ?? "");
  const valid = await verifyPassword(pin, customer.pin_hash);
  sendJson(res, 200, { valid });
});
