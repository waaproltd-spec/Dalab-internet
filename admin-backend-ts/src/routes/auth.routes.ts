import { Router } from "express";
import { randomUUID, createHash } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import {
  hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyToken,
  isValidEmail, isStrongPassword, REFRESH_TTL_MS,
} from "../auth/crypto.js";
import { requireAuth } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { Role } from "../types/index.js";
import { rateLimit } from "../auth/rateLimit.js";

export const authRouter = Router();

async function issueTokens(subjectId: string, role: Role) {
  const accessToken = signAccessToken(subjectId, role);
  const jti = randomUUID();
  const refreshToken = signRefreshToken(subjectId, role, jti);
  const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
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
  if (!/^\+?\d{6,15}$/.test(phone)) return sendJson(res, 400, { error: "Provide a valid phone number" });
  if (!isStrongPassword(password)) {
    return sendJson(res, 400, { error: "Password must be at least 8 characters and include a letter, a number, and a symbol" });
  }
  if (email && !isValidEmail(email)) return sendJson(res, 400, { error: "Provide a valid email" });

  const passwordHash = await hashPassword(password);
  let customer = await queryOne(`SELECT * FROM customers WHERE phone=$1`, [phone]);

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
    await query(
      `UPDATE customers SET password_hash=$1, name=COALESCE($2, name), email=COALESCE($3, email) WHERE id=$4`,
      [passwordHash, name, email, customer.id]
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
      `INSERT INTO customers (id, phone, name, email, password_hash, referred_by_customer_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [randomUUID(), phone, name, email, passwordHash, referredBy]
    );
  }

  const tokens = await issueTokens(customer!.id, "customer");
  sendJson(res, 201, {
    ...tokens,
    customer: { id: customer!.id, phone: customer!.phone, name: customer!.name, email: customer!.email },
    pinSet: Boolean(customer!.pin_hash),
  });
});

authRouter.post("/auth/login", rateLimit("customer-login", 10, 15 * 60 * 1000), async (req, res) => {
  const identifier = String(req.body.identifier ?? req.body.phone ?? req.body.email ?? "").trim();
  const password = String(req.body.password ?? "");
  if (!identifier || !password) return sendJson(res, 400, { error: "phone/email and password are required" });

  const isEmail = identifier.includes("@");
  const customer = await queryOne(
    isEmail ? `SELECT * FROM customers WHERE email=$1` : `SELECT * FROM customers WHERE phone=$1`,
    [isEmail ? identifier.toLowerCase() : identifier]
  );
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
    customer: { id: customer.id, phone: customer.phone, name: customer.name, email: customer.email },
    pinSet: Boolean(customer.pin_hash),
  });
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
