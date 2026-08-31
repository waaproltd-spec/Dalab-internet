import { Router } from "express";
import { randomUUID, createHash } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import {
  hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyToken,
  isValidEmail, isStrongPassword, isValidCustomerPassword, isValidPin, refreshTtlMsForRole,
} from "../auth/crypto.js";
import { requireAuth } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { Role } from "../types/index.js";
import { rateLimit } from "../auth/rateLimit.js";
import { validateMobileNumber } from "../lib/phoneValidation.js";
import { findCustomerByPhone } from "../utils/customerLookup.js";

export const authRouter = Router();

async function issueTokens(subjectId: string, role: Role) {
  const accessToken = signAccessToken(subjectId, role);
  const jti = randomUUID();
  const refreshToken = signRefreshToken(subjectId, role, jti);
  const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
  const expiresAt = new Date(Date.now() + refreshTtlMsForRole(role));
  await query(
    `INSERT INTO refresh_tokens (id, subject_id, subject_role, token_hash, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), subjectId, role, tokenHash, expiresAt]
  );
  return { accessToken, refreshToken };
}

// ---------------- Customer: phone/email + password login ----------------
// Replaces the old SMS-OTP login entirely. Phone stays the required, unique
// identifier (same as before); email is optional and, when set, is a second
// way to look the account up here. Passwords are bcrypt-hashed exactly like
// admin_users.password_hash / customers.pin_hash (see auth/crypto.ts) — no
// new hashing scheme introduced.
function normalizeCustomerPhone(raw: unknown): string {
  return String(raw ?? "").trim();
}

authRouter.post("/auth/register", rateLimit("customer-register", 10, 15 * 60 * 1000), async (req, res) => {
  const phone = normalizeCustomerPhone(req.body.phone);
  const password = String(req.body.password ?? "");
  const name = req.body.name ? String(req.body.name).trim() : null;
  const email = req.body.email ? String(req.body.email).trim().toLowerCase() : null;
  // Optional: the Customer App's Create Account screen always sends one
  // (for later Forgot Password recovery — see /auth/customer/forgot-password
  // below), but the legacy "set a password for my old OTP account" screen
  // reuses this same endpoint without a pin, and must keep working exactly
  // as before.
  const pin = req.body.pin != null ? String(req.body.pin) : null;
  const phoneCheck = validateMobileNumber(phone);
  if (!phoneCheck.valid) return sendJson(res, 400, { error: phoneCheck.error });
  if (!isValidCustomerPassword(password)) {
    return sendJson(res, 400, { error: "Password must be at least 6 characters." });
  }
  if (email && !isValidEmail(email)) return sendJson(res, 400, { error: "Provide a valid email" });
  if (pin != null && !isValidPin(pin)) return sendJson(res, 400, { error: "PIN must be 4-8 digits" });

  const passwordHash = await hashPassword(password);
  const pinHash = pin != null ? await hashPassword(pin) : null;
  let customer = await findCustomerByPhone(phone);

  if (customer) {
    // A row for this phone already exists — either a genuine "already
    // registered, go sign in instead" case, or (far more common right now)
    // a customer created under the old OTP-only flow who has never had a
    // password. Claiming that existing row (rather than erroring, or
    // inserting a duplicate) is exactly how this migration keeps every
    // historical order/points balance/PIN attached to the same account.
    if (customer.password_hash) {
      return sendJson(res, 409, { error: "An account with this phone number already exists. Please sign in instead." });
    }
    if (email) {
      const emailTaken = await queryOne(`SELECT id FROM customers WHERE email=$1 AND id<>$2`, [email, customer.id]);
      if (emailTaken) return sendJson(res, 409, { error: "An account with this email already exists." });
    }
    // COALESCE on pin_hash: a request with no pin (the legacy flow) must
    // never wipe out a PIN a Super Admin already set on this row.
    await query(
      `UPDATE customers SET password_hash=$1, name=COALESCE($2, name), email=COALESCE($3, email), pin_hash=COALESCE($4, pin_hash) WHERE id=$5`,
      [passwordHash, name, email, pinHash, customer.id]
    );
    customer = await queryOne(`SELECT * FROM customers WHERE id=$1`, [customer.id]);
  } else {
    if (email && (await queryOne(`SELECT id FROM customers WHERE email=$1`, [email]))) {
      return sendJson(res, 409, { error: "An account with this email already exists." });
    }
    // Referral relationship is fixed once, at account creation, from the
    // referral code the Customer App may have picked up from a shared
    // referral link — never reassigned afterward. An unrecognized/self/
    // omitted code is silently ignored rather than blocking registration.
    const referralCode = String(req.body.referralCode ?? "").trim();
    let referredBy: string | null = null;
    if (referralCode) {
      const referrer = await queryOne<{ id: string }>(`SELECT id FROM customers WHERE referral_code=$1`, [referralCode]);
      if (referrer) referredBy = referrer.id;
    }
    customer = await queryOne(
      `INSERT INTO customers (id, phone, name, email, password_hash, pin_hash, referred_by_customer_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), phone, name, email, passwordHash, pinHash, referredBy]
    );
  }

  const tokens = await issueTokens(customer!.id, "customer");
  sendJson(res, 201, {
    ...tokens,
    customer: {
      id: customer!.id,
      phone: customer!.phone,
      name: customer!.name,
      email: customer!.email,
      evcPlusNumber: customer!.evc_plus_number,
      edahabNumber: customer!.edahab_number,
    },
    pinSet: Boolean(customer!.pin_hash),
  });
});

authRouter.post("/auth/login", rateLimit("customer-login", 10, 15 * 60 * 1000), async (req, res) => {
  const identifier = String(req.body.identifier ?? req.body.phone ?? req.body.email ?? "").trim();
  const password = String(req.body.password ?? "");
  if (!identifier || !password) return sendJson(res, 400, { error: "phone/email and password are required" });

  const isEmail = identifier.includes("@");
  const customer = isEmail
    ? await queryOne(`SELECT * FROM customers WHERE email=$1`, [identifier.toLowerCase()])
    : await findCustomerByPhone(identifier);
  // Same generic message whether the account doesn't exist, has no password
  // yet, or the password is simply wrong — never reveal which case it is.
  const genericError = () => sendJson(res, 401, { error: "Invalid phone/email or password" });
  if (!customer) return genericError();
  if (!customer.password_hash) {
    // A legacy OTP-era account that's never set a password — tell the
    // Customer App to route to Create Account (same phone number), which
    // claims this exact row rather than making the customer feel locked out.
    return sendJson(res, 401, { error: "This account hasn't set up a password yet. Please create your account to continue.", needsPasswordSetup: true });
  }
  if (!(await verifyPassword(password, customer.password_hash))) return genericError();
  if (customer.status === "blocked") return sendJson(res, 403, { error: "This account has been blocked" });

  const tokens = await issueTokens(customer.id, "customer");
  sendJson(res, 200, {
    ...tokens,
    customer: {
      id: customer.id,
      phone: customer.phone,
      name: customer.name,
      email: customer.email,
      evcPlusNumber: customer.evc_plus_number,
      edahabNumber: customer.edahab_number,
    },
    pinSet: Boolean(customer.pin_hash),
  });
});

// ---------------- Customer: forgot password via PIN (no OTP, no email) ----------------
// Two-step so the Customer App can gate showing the new-password screen on
// a correct PIN, without trusting that check alone for the actual reset:
// verify-pin only confirms the PIN and changes nothing; reset re-verifies
// the same phone+pin from scratch before touching password_hash. Uses the
// same pin_hash column as the Super Admin's PIN management
// (customers.routes.ts) and the legacy PIN-login flow below — setting a
// PIN happens only via POST /auth/register above or a Super Admin reset,
// never self-service outside of account creation, matching
// 015_customer_pin.sql's "if a customer forgets their PIN, they contact
// Support" model.
authRouter.post("/auth/customer/forgot-password/verify-pin", rateLimit("customer-forgot-password-verify", 10, 15 * 60 * 1000), async (req, res) => {
  const phone = normalizeCustomerPhone(req.body.phone);
  const pin = String(req.body.pin ?? "");
  if (!phone || !pin) return sendJson(res, 400, { error: "phone and pin are required" });

  const customer = await findCustomerByPhone(phone);
  // Same generic message whether the phone isn't registered, has no PIN
  // set yet, or the PIN is simply wrong — never reveal which case it is.
  const genericError = () => sendJson(res, 401, { error: "Invalid phone number or PIN" });
  if (!customer || !customer.pin_hash) return genericError();
  if (!(await verifyPassword(pin, customer.pin_hash))) return genericError();
  if (customer.status === "blocked") return sendJson(res, 403, { error: "This account has been blocked" });

  sendJson(res, 200, { valid: true });
});

authRouter.post("/auth/customer/forgot-password/reset", rateLimit("customer-forgot-password-reset", 5, 15 * 60 * 1000), async (req, res) => {
  const phone = normalizeCustomerPhone(req.body.phone);
  const pin = String(req.body.pin ?? "");
  const newPassword = String(req.body.newPassword ?? "");
  if (!phone || !pin || !newPassword) return sendJson(res, 400, { error: "phone, pin, and newPassword are required" });
  if (!isValidCustomerPassword(newPassword)) {
    return sendJson(res, 400, { error: "Password must be at least 6 characters." });
  }

  const customer = await findCustomerByPhone(phone);
  const genericError = () => sendJson(res, 401, { error: "Invalid phone number or PIN" });
  if (!customer || !customer.pin_hash) return genericError();
  if (!(await verifyPassword(pin, customer.pin_hash))) return genericError();
  if (customer.status === "blocked") return sendJson(res, 403, { error: "This account has been blocked" });

  await query(`UPDATE customers SET password_hash=$1 WHERE id=$2`, [await hashPassword(newPassword), customer.id]);
  // Forces re-login everywhere, same as the admin password-reset flow —
  // the old password may be compromised, which is presumably why the
  // customer is here.
  await query(`UPDATE refresh_tokens SET revoked=true WHERE subject_id=$1`, [customer.id]);
  sendJson(res, 200, { message: "Password reset successfully. Please log in with your new password." });
});

// ---------------- Customer: passwordless name + phone identity ----------------
// The Customer App's entire auth flow: first launch asks for Full Name +
// Phone Number only, no password/PIN/OTP ever. This single endpoint both
// creates a brand-new account and signs back into an existing one — the
// phone number is the sole identifier, deliberately unverified (no OTP), so
// re-entering the same number on a reinstall/new device restores the same
// account by design. Never touches password_hash, so it can't collide with
// /auth/register's password-claiming flow for the same row.
authRouter.post("/auth/identify", rateLimit("customer-identify", 20, 15 * 60 * 1000), async (req, res) => {
  const phone = normalizeCustomerPhone(req.body.phone);
  const name = req.body.name ? String(req.body.name).trim() : "";
  const phoneCheck = validateMobileNumber(phone);
  if (!phoneCheck.valid) return sendJson(res, 400, { error: phoneCheck.error });
  if (!name) return sendJson(res, 400, { error: "Full name is required" });

  let customer = await findCustomerByPhone(phone);
  if (customer) {
    if (customer.status === "blocked") return sendJson(res, 403, { error: "This account has been blocked" });
    // Only fills in a missing name — never overwrites a name the customer
    // (or an admin) already set, since a later device re-entering the same
    // phone shouldn't silently rename an existing profile.
    if (!customer.name) {
      await query(`UPDATE customers SET name=$1 WHERE id=$2`, [name, customer.id]);
      customer = await queryOne(`SELECT * FROM customers WHERE id=$1`, [customer.id]);
    }
  } else {
    customer = await queryOne(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,$3) RETURNING *`, [randomUUID(), phone, name]);
  }

  const tokens = await issueTokens(customer!.id, "customer");
  sendJson(res, 200, {
    ...tokens,
    customer: {
      id: customer!.id,
      phone: customer!.phone,
      name: customer!.name,
      email: customer!.email,
      evcPlusNumber: customer!.evc_plus_number,
      edahabNumber: customer!.edahab_number,
    },
    pinSet: Boolean(customer!.pin_hash),
  });
});

// ---------------- Customer: name + phone + mandatory 4-digit PIN ----------------
// A second, PIN-gated Customer App auth model living alongside
// /auth/identify above rather than replacing it — same customers table and
// pin_hash column (shared with the Super Admin PIN-reset routes and the
// optional self-service PIN in customers.routes.ts), but here the PIN is
// the credential itself: signup requires setting one, and login refuses to
// issue tokens at all on a wrong PIN (unlike POST /customer/pin/verify's
// post-login UX-only check). check-phone lets the Customer App decide
// which screen to show without a blind guess — a phone that exists but has
// no PIN yet (e.g. a legacy /auth/identify row) still routes to "create a
// PIN", not "enter one that was never set".
function isFourDigitPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

authRouter.post("/auth/customer/check-phone", rateLimit("customer-check-phone", 30, 15 * 60 * 1000), async (req, res) => {
  const phone = normalizeCustomerPhone(req.body.phone);
  if (!/^\+?\d{6,15}$/.test(phone)) return sendJson(res, 400, { error: "Provide a valid phone number" });
  const customer = await findCustomerByPhone(phone);
  sendJson(res, 200, {
    exists: Boolean(customer),
    pinSet: Boolean(customer?.pin_hash),
    name: customer?.name ?? null,
  });
});

authRouter.post("/auth/customer/signup", rateLimit("customer-pin-signup", 10, 15 * 60 * 1000), async (req, res) => {
  const phone = normalizeCustomerPhone(req.body.phone);
  const name = req.body.name ? String(req.body.name).trim() : "";
  const pin = String(req.body.pin ?? "");
  const phoneCheck = validateMobileNumber(phone);
  if (!phoneCheck.valid) return sendJson(res, 400, { error: phoneCheck.error });
  if (!name) return sendJson(res, 400, { error: "Full name is required" });
  if (!isFourDigitPin(pin)) return sendJson(res, 400, { error: "PIN must be exactly 4 digits" });

  let customer = await findCustomerByPhone(phone);
  if (customer?.pin_hash) {
    return sendJson(res, 409, { error: "An account with this phone number already exists. Please sign in instead." });
  }
  if (customer?.status === "blocked") return sendJson(res, 403, { error: "This account has been blocked" });

  const pinHash = await hashPassword(pin);
  if (customer) {
    // Claims the existing (PIN-less) row exactly like /auth/register does
    // for password_hash — keeps every historical order/points balance
    // attached to the same account instead of creating a duplicate.
    // Deliberately does NOT touch referred_by_customer_id even if a
    // referralCode was passed here — this phone already had an account
    // before today, so it isn't a genuine new referral, and letting a
    // pre-existing row "claim" a referral code on demand would be a free
    // way to farm bonuses.
    await query(`UPDATE customers SET pin_hash=$1, name=COALESCE(name, $2) WHERE id=$3`, [pinHash, name, customer.id]);
    customer = await queryOne(`SELECT * FROM customers WHERE id=$1`, [customer.id]);
  } else {
    // Only a genuinely brand-new phone number can be credited as a
    // referral — resolved here (not trusted from the client as an id)
    // and silently ignored if the code doesn't match a real, active
    // referrer, same as /auth/register's referral handling.
    const referralCode = req.body.referralCode ? String(req.body.referralCode).trim() : "";
    let referredBy: string | null = null;
    if (referralCode) {
      const referrer = await queryOne<{ id: string; status: string }>(
        `SELECT id, status FROM customers WHERE referral_code=$1`,
        [referralCode]
      );
      if (referrer && referrer.status !== "blocked") referredBy = referrer.id;
    }
    customer = await queryOne(
      `INSERT INTO customers (id, phone, name, pin_hash, referred_by_customer_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [randomUUID(), phone, name, pinHash, referredBy]
    );
  }

  const tokens = await issueTokens(customer!.id, "customer");
  sendJson(res, 201, {
    ...tokens,
    customer: {
      id: customer!.id,
      phone: customer!.phone,
      name: customer!.name,
      email: customer!.email,
      evcPlusNumber: customer!.evc_plus_number,
      edahabNumber: customer!.edahab_number,
    },
  });
});

authRouter.post("/auth/customer/login", rateLimit("customer-pin-login", 10, 15 * 60 * 1000), async (req, res) => {
  const phone = normalizeCustomerPhone(req.body.phone);
  const pin = String(req.body.pin ?? "");
  if (!phone || !pin) return sendJson(res, 400, { error: "phone and pin are required" });

  const customer = await findCustomerByPhone(phone);
  // Same generic message whether the phone isn't registered, has no PIN
  // yet, or the PIN is simply wrong — never reveal which case it is.
  const genericError = () => sendJson(res, 401, { error: "Invalid phone number or PIN" });
  if (!customer || !customer.pin_hash) return genericError();
  if (!(await verifyPassword(pin, customer.pin_hash))) return genericError();
  if (customer.status === "blocked") return sendJson(res, 403, { error: "This account has been blocked" });

  const tokens = await issueTokens(customer.id, "customer");
  sendJson(res, 200, {
    ...tokens,
    customer: {
      id: customer.id,
      phone: customer.phone,
      name: customer.name,
      email: customer.email,
      evcPlusNumber: customer.evc_plus_number,
      edahabNumber: customer.edahab_number,
    },
  });
});

// Best-effort session teardown for the Customer App's explicit "Log out" —
// revokes just this one refresh token (same token_hash lookup /auth/refresh
// already uses) so it can't be replayed; a missing/already-invalid token is
// still a 200, since the client is clearing its local session either way.
authRouter.post("/auth/logout", async (req, res) => {
  const refreshToken = String(req.body.refreshToken ?? "");
  if (refreshToken) {
    const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
    await query(`UPDATE refresh_tokens SET revoked=true WHERE token_hash=$1`, [tokenHash]);
  }
  sendJson(res, 200, { message: "Logged out" });
});

// ---------------- Agent login (fully automatic — no credentials at all) ----------------
// The Agent App has no login screen: it authenticates itself using whichever
// agent the Super Admin has assigned to this physical device (agents.device_id,
// set via PUT /admin/agents/:id/device). The app already learns its own
// deviceId during device setup (a one-time, non-credential step — see
// GET /agent/devices), so this needs nothing else from the person using it.
authRouter.post("/agent/auth/device-login", rateLimit("agent-device-login", 30, 15 * 60 * 1000), async (req, res) => {
  const deviceId = String(req.body.deviceId ?? "").trim();
  if (!deviceId) return sendJson(res, 400, { error: "deviceId is required" });
  const agent = await queryOne(
    `SELECT * FROM agents WHERE device_id=$1 AND status='active' ORDER BY created_at ASC LIMIT 1`,
    [deviceId]
  );
  if (!agent) {
    return sendJson(res, 404, { error: "No active agent account is assigned to this device yet. Ask your Super Admin to assign one from the dashboard." });
  }

  await query(`UPDATE agents SET last_login_at = now() WHERE id=$1`, [agent.id]);
  const tokens = await issueTokens(agent.id, "agent");
  sendJson(res, 200, { ...tokens, agent: { id: agent.id, name: agent.name, phone: agent.phone } });
});

// ---------------- Admin / Super Admin login ----------------
authRouter.post("/admin/auth/login", rateLimit("admin-login", 5, 15 * 60 * 1000), async (req, res) => {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");
  if (!isValidEmail(email) || !password) {
    return sendJson(res, 400, { error: "A valid email and password are required" });
  }
  const admin = await queryOne(`SELECT * FROM admin_users WHERE email=$1`, [email]);
  if (!admin || !(await verifyPassword(password, admin.password_hash))) {
    return sendJson(res, 401, { error: "Invalid email or password" });
  }
  await query(`UPDATE admin_users SET last_login_at = now() WHERE id=$1`, [admin.id]);
  const tokens = await issueTokens(admin.id, admin.role as Role);
  sendJson(res, 200, {
    ...tokens,
    admin: { id: admin.id, email: admin.email, role: admin.role, permissions: admin.permissions ?? [] },
  });
});

authRouter.post("/admin/auth/change-password", requireAuth("super_admin", "admin"), rateLimit("change-password", 5, 15 * 60 * 1000), async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return sendJson(res, 400, { error: "currentPassword and newPassword are required" });
  if (!isStrongPassword(newPassword)) {
    return sendJson(res, 400, { error: "New password must be at least 8 characters and include a letter, a number, and a symbol" });
  }
  const admin = await queryOne(`SELECT * FROM admin_users WHERE id=$1`, [req.auth!.sub]);
  if (!admin || !(await verifyPassword(currentPassword, admin.password_hash))) {
    return sendJson(res, 401, { error: "Current password is incorrect" });
  }
  await query(`UPDATE admin_users SET password_hash=$1 WHERE id=$2`, [await hashPassword(newPassword), admin.id]);
  sendJson(res, 200, { message: "Password changed successfully" });
});

authRouter.post("/admin/auth/forgot-password", rateLimit("forgot-password", 3, 60 * 60 * 1000), async (req, res) => {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  if (!isValidEmail(email)) return sendJson(res, 400, { error: "A valid email is required" });

  const admin = await queryOne(`SELECT * FROM admin_users WHERE email=$1`, [email]);
  const response: Record<string, unknown> = { message: "If that email has an account, a reset link has been sent." };

  if (admin) {
    const resetToken = randomUUID() + randomUUID();
    await query(
      `INSERT INTO admin_password_resets (id, admin_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + interval '30 minutes')`,
      [randomUUID(), admin.id, createHash("sha256").update(resetToken).digest("hex")]
    );
    // eslint-disable-next-line no-console
    console.log(`[EMAIL SIM] Password reset for ${email}: https://admin.example.com/reset-password?token=${resetToken}`);
    if (process.env.NODE_ENV !== "production") response.debugResetToken = resetToken;
  }
  sendJson(res, 200, response);
});

authRouter.post("/admin/auth/reset-password", rateLimit("reset-password", 10, 15 * 60 * 1000), async (req, res) => {
  const token = String(req.body.token ?? "");
  const newPassword = String(req.body.newPassword ?? "");
  if (!token || !newPassword) return sendJson(res, 400, { error: "token and newPassword are required" });
  if (!isStrongPassword(newPassword)) {
    return sendJson(res, 400, { error: "New password must be at least 8 characters and include a letter, a number, and a symbol" });
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const row = await queryOne(
    `SELECT * FROM admin_password_resets WHERE token_hash=$1 AND consumed=false AND expires_at > now()`,
    [tokenHash]
  );
  if (!row) return sendJson(res, 401, { error: "Invalid or expired reset link" });

  await query(`UPDATE admin_password_resets SET consumed=true WHERE id=$1`, [row.id]);
  await query(`UPDATE admin_users SET password_hash=$1 WHERE id=$2`, [await hashPassword(newPassword), row.admin_id]);
  await query(`UPDATE refresh_tokens SET revoked=true WHERE subject_id=$1`, [row.admin_id]);
  sendJson(res, 200, { message: "Password reset successfully. Please log in with your new password." });
});

// ---------------- Refresh (shared by all roles) ----------------
// ---------------- Reseller login (admin-issued reseller ID + 8-digit PIN, no self-registration) ----------------
// A Reseller must be created by an Admin first (POST /admin/resellers) —
// there is no equivalent of /auth/register here. Same "never reveal which
// part was wrong" convention as every other login in this file: a bad
// resellerId, a bad PIN, and an inactive account all return the exact same
// message the Customer App is required to show verbatim.
authRouter.post("/reseller/auth/login", rateLimit("reseller-login", 5, 15 * 60 * 1000), async (req, res) => {
  const resellerLoginId = String(req.body.resellerId ?? "").trim();
  const pin = String(req.body.pin ?? "");
  const genericError = () => sendJson(res, 401, { error: "Invalid ID/PIN. Please contact Admin." });
  if (!resellerLoginId || !pin) return genericError();

  const reseller = await queryOne(`SELECT * FROM resellers WHERE reseller_login_id=$1`, [resellerLoginId]);
  if (!reseller) return genericError();
  if (!(await verifyPassword(pin, reseller.pin_hash))) return genericError();
  if (reseller.status !== "active") return genericError();

  await query(`UPDATE resellers SET last_login_at = now() WHERE id=$1`, [reseller.id]);
  const wallet = await queryOne(`SELECT balance FROM reseller_wallets WHERE reseller_id=$1`, [reseller.id]);
  const tokens = await issueTokens(reseller.id, "reseller");
  sendJson(res, 200, {
    ...tokens,
    reseller: {
      id: reseller.id,
      resellerLoginId: reseller.reseller_login_id,
      name: reseller.name,
      walletBalance: wallet?.balance ?? 0,
    },
  });
});

authRouter.post("/auth/refresh", async (req, res) => {
  const refreshToken = String(req.body.refreshToken ?? "");
  const payload = verifyToken(refreshToken);
  if (!payload || payload.type !== "refresh") return sendJson(res, 401, { error: "Invalid refresh token" });

  const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
  const row = await queryOne(
    `SELECT * FROM refresh_tokens WHERE token_hash=$1 AND revoked=false AND expires_at > now()`,
    [tokenHash]
  );
  if (!row) return sendJson(res, 401, { error: "Refresh token revoked or expired" });

  // A Reseller session must end the moment Admin disables the account —
  // otherwise a device that logged in while still active keeps silently
  // refreshing forever, ignoring that later change (Req: "login should only
  // be required again if the Admin disables the Reseller account"). Scoped
  // to just this role: every other role's refresh behavior is unchanged.
  if (payload.role === "reseller") {
    const reseller = await queryOne<{ status: string }>(`SELECT status FROM resellers WHERE id=$1`, [payload.sub]);
    if (!reseller || reseller.status !== "active") {
      await query(`UPDATE refresh_tokens SET revoked=true WHERE id=$1`, [row.id]);
      return sendJson(res, 401, { error: "This Reseller account is no longer active" });
    }
  }

  await query(`UPDATE refresh_tokens SET revoked=true WHERE id=$1`, [row.id]);
  const tokens = await issueTokens(payload.sub, payload.role);
  sendJson(res, 200, tokens);
});

// ---------------- Seed the one Super Admin account (idempotent) ----------------
export async function seedSuperAdmin(): Promise<void> {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL ?? "admin@example.com";
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD ?? "ChangeMe123!";
  const existing = await queryOne(`SELECT id FROM admin_users WHERE email=$1`, [email]);
  if (existing) return;
  await query(
    `INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,$2,$3,'super_admin')`,
    [randomUUID(), email, await hashPassword(password)]
  );
  // eslint-disable-next-line no-console
  console.log(`Seeded Super Admin: ${email} — change this password immediately after first login.`);
}
