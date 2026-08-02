import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { hashPassword, verifyPassword, isValidPin } from "../auth/crypto.js";

export const customersRouter = Router();

// pin_hash must never reach any client — explicit column list (plus a
// derived pinSet boolean) rather than SELECT *, same convention already
// used for pin_encrypted on companies.
const ADMIN_CUSTOMER_COLUMNS = `id, phone, name, email, status, macaash_points, created_at, (pin_hash IS NOT NULL) AS pin_set, (password_hash IS NOT NULL) AS has_password`;

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
const CUSTOMER_PROFILE_COLUMNS = "id, phone, name, email, macaash_points, created_at";

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

// Same handler covers both "create" and "change" for the same reason the
// Super Admin route does — being authenticated as this customer (via the
// login-issued token) is already the proof of ownership needed to set a new one.
customersRouter.put("/customer/pin", requireAuth("customer"), async (req, res) => {
  const { pin } = req.body;
  if (!isValidPin(String(pin ?? ""))) return sendJson(res, 400, { error: "PIN must be 4-8 digits" });
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
