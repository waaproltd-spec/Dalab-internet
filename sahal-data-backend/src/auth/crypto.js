import { scryptSync, randomBytes, timingSafeEqual, createHmac, createCipheriv, createDecipheriv } from "node:crypto";

// ---------- Password hashing (scrypt, salted, constant-time compare) ----------
// This is what bcrypt/argon2 packages would normally do; scrypt is in Node core
// so it needs no dependency, and is an accepted password-hashing KDF (RFC 7914).

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------- JWT (HMAC-SHA256) ----------
// A minimal, dependency-free JWT implementation — same three-part structure
// (header.payload.signature) any `jsonwebtoken`-signed token would have, so a
// production deploy can swap this for that package with zero API changes.

const SECRET = process.env.JWT_SECRET ?? "dev-only-secret-change-in-production";

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(input) {
  input = input.replace(/-/g, "+").replace(/_/g, "/");
  while (input.length % 4) input += "=";
  return Buffer.from(input, "base64").toString("utf8");
}

export function signToken(payload, expiresInSeconds) {
  const header = { alg: "HS256", typ: "JWT" };
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedBody = base64url(JSON.stringify(body));
  const signature = createHmac("sha256", SECRET).update(`${encodedHeader}.${encodedBody}`).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encodedHeader}.${encodedBody}.${signature}`;
}

export function verifyToken(token) {
  const parts = token?.split(".") ?? [];
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedBody, signature] = parts;
  const expectedSig = createHmac("sha256", SECRET).update(`${encodedHeader}.${encodedBody}`).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(base64urlDecode(encodedBody));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null; // expired
  return payload;
}

// ---------- Reversible encryption (for secrets we must recover, not verify) ----------
// The Super Admin PIN has to be embedded into a literal USSD dialer string
// ("*914*...*8233<PIN>#"), so it cannot be one-way hashed like a password —
// it must be decryptable. AES-256-GCM with a server-side key is the standard
// tool for "encrypted at rest, recoverable when needed" secrets like this.
const ENCRYPTION_SECRET = process.env.ENCRYPTION_KEY ?? "dev-only-encryption-key-change-in-production";
const ENCRYPTION_KEY = scryptSync(ENCRYPTION_SECRET, "sahal-data-ussd-pin-salt", 32);

export function encrypt(plaintext) {
  const iv = randomBytes(12); // GCM standard IV size
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store iv:authTag:ciphertext, all hex — self-contained, no separate IV column needed.
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decrypt(stored) {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  const decipher = createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}

// ---------- Validation ----------
export function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// Matches the strength of the seeded default password (Yaas120@): 8+ chars,
// at least one letter, one number, one symbol. Applied to change-password and
// reset-password, not to login (login just checks the hash matches).
export function isStrongPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    /[A-Za-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

// ---------- OTP ----------
export function generateOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
export function hashOtp(code) {
  return createHmac("sha256", SECRET).update(code).digest("hex");
}
