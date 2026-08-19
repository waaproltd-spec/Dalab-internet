import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { hashPassword, verifyPassword, isValidPin } from "../auth/crypto.js";
import { parseDataUri } from "../utils/dataUri.js";
import { validateMobileNumber } from "../lib/phoneValidation.js";

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
  if (phone !== existing.phone) {
    const phoneCheck = validateMobileNumber(String(phone));
    if (!phoneCheck.valid) return sendJson(res, 400, { error: phoneCheck.error });
  }
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
    if (field in body && body[field] != null) {
      const check = validateMobileNumber(String(body[field]), field === "evcPlusNumber" ? "evc_plus" : "edahab");
      if (!check.valid) return sendJson(res, 400, { error: check.error });
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

// ---------------- Password Recovery: Reset Recovery PIN (Super Admin only) ----------------
// The Customer App's Forgot Password flow directs a customer who's forgotten
// their Recovery PIN to Contact Admin; this is that admin-side action. Unlike
// PUT /pin above (where the Super Admin types a specific value), this one
// always generates the new PIN itself — the Super Admin never chooses or
// types it, only relays it out-of-band once generated. A fresh call always
// overwrites pin_hash, so the customer's previous Recovery PIN stops working
// the instant a new one is generated, with no separate "invalidate" step
// needed. The plaintext PIN is returned exactly once, in this response only —
// never logged, never stored anywhere but this bcrypt hash.
customersRouter.post("/admin/customers/:id/pin/generate", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM customers WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Customer not found" });
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  const pinHash = await hashPassword(pin);
  await query(`UPDATE customers SET pin_hash=$1 WHERE id=$2`, [pinHash, req.params.id]);
  sendJson(res, 200, { message: "New Recovery PIN generated", pin, isSet: true });
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
  const phoneCheck = validateMobileNumber(phone);
  if (!phoneCheck.valid) return sendJson(res, 400, { error: phoneCheck.error });
  const name = req.body.name ? String(req.body.name).trim() : null;

  const existing = await queryOne(`SELECT ${AGENT_CUSTOMER_COLUMNS} FROM customers WHERE phone=$1`, [phone]);
  if (existing) return sendJson(res, 409, { error: "A customer with this phone already exists", customer: existing });

  const id = randomUUID();
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,$3)`, [id, phone, name]);
  sendJson(res, 201, await queryOne(`SELECT ${AGENT_CUSTOMER_COLUMNS} FROM customers WHERE id=$1`, [id]));
});

// ---------------- Customer: own profile ----------------
const CUSTOMER_PROFILE_COLUMNS =
  "id, phone, name, email, macaash_points, evc_plus_name, evc_plus_number, evc_plus_saved_at, edahab_name, edahab_number, edahab_saved_at, photo_base64, created_at";

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

// Stored inline as the full "data:<mime>;base64,<data>" string (rather than
// bytes + a separate served-by-id route like promo_images) because a
// customer's photo is private and always fetched as part of their own
// profile response — there's no public <img src> case to optimize for here.
const PROFILE_PHOTO_MAX_BYTES = 4 * 1024 * 1024;
const PROFILE_PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

customersRouter.put("/customer/profile/photo", requireAuth("customer"), async (req, res) => {
  const parsed = parseDataUri(req.body.photoBase64);
  if (!parsed) return sendJson(res, 400, { error: "photoBase64 must be a data:<mime>;base64,<data> string" });
  if (!PROFILE_PHOTO_MIME_TYPES.has(parsed.mimeType)) {
    return sendJson(res, 400, { error: "Photo must be a JPEG, PNG, or WEBP image" });
  }
  if (parsed.data.length > PROFILE_PHOTO_MAX_BYTES) {
    return sendJson(res, 400, { error: "Photo must be 4MB or smaller" });
  }
  await query(`UPDATE customers SET photo_base64=$1 WHERE id=$2`, [String(req.body.photoBase64), req.auth!.sub]);
  sendJson(res, 200, await queryOne(`SELECT ${CUSTOMER_PROFILE_COLUMNS} FROM customers WHERE id=$1`, [req.auth!.sub]));
});

customersRouter.delete("/customer/profile/photo", requireAuth("customer"), async (req, res) => {
  await query(`UPDATE customers SET photo_base64=NULL WHERE id=$1`, [req.auth!.sub]);
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
    if (field in body && body[field] != null) {
      const check = validateMobileNumber(String(body[field]), field === "evcPlusNumber" ? "evc_plus" : "edahab");
      if (!check.valid) return sendJson(res, 400, { error: check.error });
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
