import { Router } from "express";
import { randomUUID, createHash } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import {
  hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyToken,
  isValidEmail, isStrongPassword, generateOtp, REFRESH_TTL_MS,
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

// ---------------- Customer: OTP login ----------------
authRouter.post("/auth/otp/request", rateLimit("otp-request", 5, 15 * 60 * 1000), async (req, res) => {
  const phone = String(req.body.phone ?? "").trim();
  if (!/^\+?\d{6,15}$/.test(phone)) {
    return sendJson(res, 400, { error: "Provide a valid phone number" });
  }
  const code = generateOtp();
  await query(
    `INSERT INTO otp_codes (id, phone, code_hash, expires_at) VALUES ($1,$2,$3, now() + interval '2 minutes')`,
    [randomUUID(), phone, createHash("sha256").update(code).digest("hex")]
  );
  // eslint-disable-next-line no-console
  console.log(`[SMS GATEWAY SIM] OTP for ${phone}: ${code}`); // real gateway integration goes here

  const response: Record<string, unknown> = { message: "OTP sent" };
  if (process.env.NODE_ENV !== "production") response.debugCode = code;
  sendJson(res, 200, response);
});

authRouter.post("/auth/otp/verify", rateLimit("otp-verify", 10, 15 * 60 * 1000), async (req, res) => {
  const phone = String(req.body.phone ?? "").trim();
  const code = String(req.body.code ?? "").trim();
  if (!phone || !code) return sendJson(res, 400, { error: "phone and code are required" });

  const codeHash = createHash("sha256").update(code).digest("hex");
  const row = await queryOne(
    `SELECT * FROM otp_codes WHERE phone=$1 AND consumed=false AND expires_at > now() AND code_hash=$2
     ORDER BY created_at DESC LIMIT 1`,
    [phone, codeHash]
  );
  if (!row) return sendJson(res, 401, { error: "Invalid or expired code" });
  await query(`UPDATE otp_codes SET consumed=true WHERE id=$1`, [row.id]);

  let customer = await queryOne(`SELECT * FROM customers WHERE phone=$1`, [phone]);
  if (!customer) {
    customer = await queryOne(`INSERT INTO customers (id, phone) VALUES ($1,$2) RETURNING *`, [randomUUID(), phone]);
  }
  if (customer!.status === "blocked") return sendJson(res, 403, { error: "This account has been blocked" });

  const tokens = await issueTokens(customer!.id, "customer");
  sendJson(res, 200, { ...tokens, customer: { id: customer!.id, phone: customer!.phone, name: customer!.name } });
});

// ---------------- Agent login ----------------
authRouter.post("/agent/auth/login", rateLimit("agent-login", 5, 15 * 60 * 1000), async (req, res) => {
  const phone = String(req.body.phone ?? "").trim();
  const password = String(req.body.password ?? "");
  const agent = await queryOne(`SELECT * FROM agents WHERE phone=$1`, [phone]);
  if (!agent || !(await verifyPassword(password, agent.password_hash))) {
    return sendJson(res, 401, { error: "Invalid phone or password" });
  }
  if (agent.status === "suspended") return sendJson(res, 403, { error: "Agent account suspended" });

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
  sendJson(res, 200, { ...tokens, admin: { id: admin.id, email: admin.email, role: admin.role } });
});

authRouter.post("/admin/auth/change-password", requireAuth("super_admin", "admin"), async (req, res) => {
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

authRouter.post("/admin/auth/reset-password", async (req, res) => {
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
