import { createCipheriv, createDecipheriv, randomBytes, randomInt, scryptSync } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt, { SignOptions } from "jsonwebtoken";
import { JwtPayload, Role } from "../types/index.js";

/** Fails fast in production rather than silently running with a known,
 * publicly-visible-in-source-control fallback secret — render.yaml already
 * auto-generates real values for both, so this only ever fires on a
 * misconfigured deploy. Local/dev runs keep the fallback for convenience. */
function requiredSecret(envVar: string, devFallback: string): string {
  const value = process.env[envVar];
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${envVar} is not set. Refusing to start in production with a default secret.`);
  }
  return devFallback;
}

// ---------- Passwords ----------
// bcryptjs (pure JS) rather than the native `bcrypt` package deliberately —
// native modules need a compilation step during `npm install` that can fail
// on a host's build environment; bcryptjs has no such risk on Render.
const BCRYPT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ---------- Reversible encryption (for the per-provider USSD PIN) ----------
// A PIN must be recoverable in plaintext to build a literal USSD dialer
// string, so — unlike passwords — it's encrypted, not hashed. Real
// AES-256-GCM via Node's built-in crypto module, no dependency needed.
const ENCRYPTION_SECRET = requiredSecret("ENCRYPTION_KEY", "dev-only-encryption-key-change-in-production");
const ENCRYPTION_KEY = scryptSync(ENCRYPTION_SECRET, "dalab-pin-salt", 32);

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decrypt(stored: string): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  const decipher = createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}

// ---------- JWT ----------
const JWT_SECRET: string = requiredSecret("JWT_SECRET", "dev-only-jwt-secret-change-in-production");
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
// Resellers get a far longer-lived refresh token than every other role: the
// product requirement is that a Reseller signs in once with their admin-
// issued ID + PIN and is never asked again on that device, no matter how
// long they go between opens ("even after 1 year") -- the only thing that
// should ever force it is an explicit Logout tap or Admin disabling the
// account (see /auth/refresh's existing reseller-status check, which this
// long TTL doesn't change). 10 years is effectively "forever" for a mobile
// app's realistic lifetime without ever risking an unbounded/non-expiring
// JWT. Customer/agent/admin keep the original 30-day TTL -- unrelated to
// this requirement and deliberately left unchanged.
const RESELLER_REFRESH_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

function refreshTtlSecondsForRole(role: Role): number {
  return role === "reseller" ? RESELLER_REFRESH_TTL_SECONDS : REFRESH_TTL_SECONDS;
}

export function signAccessToken(sub: string, role: Role): string {
  return jwt.sign({ sub, role } as object, JWT_SECRET, { expiresIn: ACCESS_TTL_SECONDS } as SignOptions);
}

export function signRefreshToken(sub: string, role: Role, jti: string): string {
  return jwt.sign({ sub, role, type: "refresh", jti } as object, JWT_SECRET, {
    expiresIn: refreshTtlSecondsForRole(role),
  } as SignOptions);
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

/** The refresh_tokens.expires_at value to store, matching whatever TTL
 * signRefreshToken actually signed the JWT with for this role -- must stay
 * in sync with refreshTtlSecondsForRole or /auth/refresh's DB expiry check
 * would reject a still-JWT-valid reseller token early (or vice versa). */
export function refreshTtlMsForRole(role: Role): number {
  return refreshTtlSecondsForRole(role) * 1000;
}

// ---------- Validation ----------
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function isStrongPassword(password: string): boolean {
  return password.length >= 8 && /[A-Za-z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password);
}

export function isValidPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

/** `length` comes from the configurable `otp_length` system setting — the
 * caller is responsible for clamping it to a sane range before calling. */
export function generateOtp(length = 4): string {
  const min = 10 ** (length - 1);
  const max = 10 ** length;
  return String(randomInt(min, max));
}
