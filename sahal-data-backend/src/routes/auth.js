import { randomUUID, createHash } from "node:crypto";
import {
  generateOtp, hashOtp, hashPassword, verifyPassword, signToken, verifyToken,
  isValidEmail, isStrongPassword,
} from "../auth/crypto.js";
import { requireAuth } from "../auth/middleware.js";

const ACCESS_TTL = 15 * 60;          // 15 minutes
const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days

function issueTokens(db, { id, role }) {
  const accessToken = signToken({ sub: id, role }, ACCESS_TTL);
  const refreshToken = signToken({ sub: id, role, type: "refresh", jti: randomUUID() }, REFRESH_TTL);
  const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
  db.prepare(
    `INSERT INTO refresh_tokens (id, subject_id, subject_role, token_hash, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', '+30 days'))`
  ).run(randomUUID(), id, role, tokenHash);
  return { accessToken, refreshToken };
}

export function registerAuthRoutes(app, db) {
  // ---------------- Customer: OTP request/verify ----------------
  app.post("/auth/otp/request", async (ctx) => {
    const phone = String(ctx.body.phone ?? "").trim();
    if (!/^\+?\d{6,15}$/.test(phone)) {
      return ctx.json(400, { error: "Provide a valid phone number" });
    }
    const code = generateOtp();
    db.prepare(
      `INSERT INTO otp_codes (id, phone, code_hash, expires_at)
       VALUES (?, ?, ?, datetime('now', '+2 minutes'))`
    ).run(randomUUID(), phone, hashOtp(code));

    // Simulates the SMS gateway described in the architecture doc — in
    // production this line is replaced by a real aggregator API call, and
    // `debugCode` must never be sent in the response.
    console.log(`[SMS GATEWAY SIM] OTP for ${phone}: ${code}`);

    const response = { message: "OTP sent" };
    if (process.env.NODE_ENV !== "production") response.debugCode = code;
    ctx.json(200, response);
  });

  app.post("/auth/otp/verify", async (ctx) => {
    const phone = String(ctx.body.phone ?? "").trim();
    const code = String(ctx.body.code ?? "").trim();
    if (!phone || !code) return ctx.json(400, { error: "phone and code are required" });

    const row = db.prepare(
      `SELECT * FROM otp_codes WHERE phone = ? AND consumed = 0 AND expires_at > datetime('now')
       ORDER BY created_at DESC LIMIT 1`
    ).get(phone);

    if (!row || row.code_hash !== hashOtp(code)) {
      return ctx.json(401, { error: "Invalid or expired code" });
    }
    db.prepare(`UPDATE otp_codes SET consumed = 1 WHERE id = ?`).run(row.id);

    let customer = db.prepare(`SELECT * FROM customers WHERE phone = ?`).get(phone);
    if (!customer) {
      const id = randomUUID();
      db.prepare(`INSERT INTO customers (id, phone) VALUES (?, ?)`).run(id, phone);
      customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
    }
    if (customer.status === "blocked") {
      return ctx.json(403, { error: "This account has been blocked" });
    }

    const tokens = issueTokens(db, { id: customer.id, role: "customer" });
    ctx.json(200, { ...tokens, customer: { id: customer.id, phone: customer.phone, name: customer.name } });
  });

  // ---------------- Agent login ----------------
  app.post("/agent/auth/login", async (ctx) => {
    const phone = String(ctx.body.phone ?? "").trim();
    const password = String(ctx.body.password ?? "");
    const agent = db.prepare(`SELECT * FROM agents WHERE phone = ?`).get(phone);
    if (!agent || !verifyPassword(password, agent.password_hash)) {
      return ctx.json(401, { error: "Invalid phone or password" });
    }
    if (agent.status === "suspended") return ctx.json(403, { error: "Agent account suspended" });

    db.prepare(`UPDATE agents SET last_login_at = datetime('now') WHERE id = ?`).run(agent.id);
    const tokens = issueTokens(db, { id: agent.id, role: "agent" });
    ctx.json(200, { ...tokens, agent: { id: agent.id, name: agent.name, phone: agent.phone } });
  });

  // ---------------- Admin login ----------------
  app.post("/admin/auth/login", async (ctx) => {
    const email = String(ctx.body.email ?? "").trim().toLowerCase();
    const password = String(ctx.body.password ?? "");

    if (!isValidEmail(email) || !password) {
      return ctx.json(400, { error: "A valid email and password are required" });
    }

    const admin = db.prepare(`SELECT * FROM admin_users WHERE email = ?`).get(email);
    if (!admin || !verifyPassword(password, admin.password_hash)) {
      return ctx.json(401, { error: "Invalid email or password" });
    }
    db.prepare(`UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?`).run(admin.id);
    const tokens = issueTokens(db, { id: admin.id, role: "super_admin" });
    ctx.json(200, { ...tokens, admin: { id: admin.id, email: admin.email, role: admin.role } });
  });

  // ---------------- Admin: change password (while logged in) ----------------
  app.post("/admin/auth/change-password", requireAuth("super_admin"), async (ctx) => {
    const { currentPassword, newPassword } = ctx.body;
    if (!currentPassword || !newPassword) {
      return ctx.json(400, { error: "currentPassword and newPassword are required" });
    }
    if (!isStrongPassword(newPassword)) {
      return ctx.json(400, { error: "New password must be at least 8 characters and include a letter, a number, and a symbol" });
    }
    const admin = db.prepare(`SELECT * FROM admin_users WHERE id = ?`).get(ctx.auth.sub);
    if (!admin || !verifyPassword(currentPassword, admin.password_hash)) {
      return ctx.json(401, { error: "Current password is incorrect" });
    }
    db.prepare(`UPDATE admin_users SET password_hash = ? WHERE id = ?`).run(hashPassword(newPassword), admin.id);
    ctx.json(200, { message: "Password changed successfully" });
  });

  // ---------------- Admin: forgot password ----------------
  app.post("/admin/auth/forgot-password", async (ctx) => {
    const email = String(ctx.body.email ?? "").trim().toLowerCase();
    if (!isValidEmail(email)) return ctx.json(400, { error: "A valid email is required" });

    const admin = db.prepare(`SELECT * FROM admin_users WHERE email = ?`).get(email);
    // Always return the same generic response whether or not the email
    // exists — this prevents an attacker from using this endpoint to
    // discover which email addresses have admin accounts.
    const genericResponse = { message: "If that email has an account, a reset link has been sent." };

    if (admin) {
      const resetToken = randomUUID() + randomUUID(); // long, unguessable, single-use
      db.prepare(
        `INSERT INTO admin_password_resets (id, admin_id, token_hash, expires_at)
         VALUES (?, ?, ?, datetime('now', '+30 minutes'))`
      ).run(randomUUID(), admin.id, hashOtp(resetToken));

      // Simulates the transactional-email provider (SendGrid/SES/etc.) a
      // real deployment would call here — this sandbox has no network
      // access to actually send email, so it logs the link instead.
      console.log(`[EMAIL SIM] Password reset for ${email}: https://admin.sahaldata.so/reset-password?token=${resetToken}`);

      if (process.env.NODE_ENV !== "production") genericResponse.debugResetToken = resetToken;
    }
    ctx.json(200, genericResponse);
  });

  // ---------------- Admin: reset password (via emailed token) ----------------
  app.post("/admin/auth/reset-password", async (ctx) => {
    const token = String(ctx.body.token ?? "");
    const newPassword = String(ctx.body.newPassword ?? "");
    if (!token || !newPassword) return ctx.json(400, { error: "token and newPassword are required" });
    if (!isStrongPassword(newPassword)) {
      return ctx.json(400, { error: "New password must be at least 8 characters and include a letter, a number, and a symbol" });
    }

    const tokenHash = hashOtp(token);
    const row = db.prepare(
      `SELECT * FROM admin_password_resets WHERE token_hash = ? AND consumed = 0 AND expires_at > datetime('now')`
    ).get(tokenHash);
    if (!row) return ctx.json(401, { error: "Invalid or expired reset link" });

    db.prepare(`UPDATE admin_password_resets SET consumed = 1 WHERE id = ?`).run(row.id);
    db.prepare(`UPDATE admin_users SET password_hash = ? WHERE id = ?`).run(hashPassword(newPassword), row.admin_id);
    // Revoke all existing sessions for this admin — a password reset should
    // invalidate any refresh token issued before the compromise/reset.
    db.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE subject_id = ? AND subject_role = 'super_admin'`).run(row.admin_id);

    ctx.json(200, { message: "Password reset successfully. Please log in with your new password." });
  });

  // ---------------- Refresh (shared by all three roles) ----------------
  app.post("/auth/refresh", async (ctx) => {
    const refreshToken = String(ctx.body.refreshToken ?? "");
    const payload = verifyToken(refreshToken);
    if (!payload || payload.type !== "refresh") return ctx.json(401, { error: "Invalid refresh token" });

    const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
    const row = db.prepare(
      `SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0 AND expires_at > datetime('now')`
    ).get(tokenHash);
    if (!row) return ctx.json(401, { error: "Refresh token revoked or expired" });

    // Rotate: revoke the old one, issue a new pair.
    db.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE id = ?`).run(row.id);
    const tokens = issueTokens(db, { id: payload.sub, role: payload.role });
    ctx.json(200, tokens);
  });
}

export function seedAdminAndAgent(db) {
  // Idempotent dev seed so the server is testable immediately after a fresh
  // `npm start`. This is the ONE and ONLY Super Admin account — there is no
  // admin self-registration endpoint anywhere in this API, by design, so
  // this seeded account is the sole way in to /admin/* routes.
  const adminEmail = "aarandata33@gmail.com";
  if (!db.prepare(`SELECT id FROM admin_users WHERE email = ?`).get(adminEmail)) {
    db.prepare(`INSERT INTO admin_users (id, email, password_hash, role) VALUES (?, ?, ?, 'super_admin')`)
      .run(randomUUID(), adminEmail, hashPassword("Yaas120@"));
  }
  const agentPhone = "252610000001";
  if (!db.prepare(`SELECT id FROM agents WHERE phone = ?`).get(agentPhone)) {
    db.prepare(`INSERT INTO agents (id, phone, name, password_hash) VALUES (?, ?, ?, ?)`)
      .run(randomUUID(), agentPhone, "Demo Agent", hashPassword("AgentPass123!"));
  }
}
