import jwtLib from "jsonwebtoken";

// This project ships a minimal local type stub for jsonwebtoken; the
// verify options used here (algorithms, issuer, audience, maxAge) are part
// of the real library.
const jwt = jwtLib as unknown as { verify: (token: string, key: string, options: Record<string, unknown>) => unknown };
import { query } from "../db/pool.js";

/**
 * Admin Hub link. Off unless both HUB_PUBLIC_KEY (the hub's ES256 public
 * key, PEM; "\n" escapes allowed) and HUB_SYSTEM_KEY (this system's key at
 * the hub, e.g. "danwadaag") are set -- with them unset nothing here changes
 * how this system behaves.
 */
export const HUB_ISSUER = "waaproltd-admin-hub";

export function hubSystemKey(): string | null {
  return process.env.HUB_SYSTEM_KEY?.trim() || null;
}

function hubPublicKey(): string | null {
  const raw = process.env.HUB_PUBLIC_KEY;
  return raw ? raw.replace(/\\n/g, "\n") : null;
}

export function hubEnabled(): boolean {
  return Boolean(hubSystemKey() && hubPublicKey());
}

/** HUB_ONLY_LOGIN=true: admins sign in only through the hub (no local passwords). */
export function hubOnlyLogin(): boolean {
  return hubEnabled() && process.env.HUB_ONLY_LOGIN === "true";
}

export type HubClaims = { [key: string]: unknown; typ: string; jti: string; sub?: string; exp?: number };

/**
 * Verifies a message from the hub: ES256 signature by the hub's key, issued
 * by the hub, addressed to THIS system, of the expected kind, not expired,
 * and never seen before. Returns null on any failure.
 */
export async function verifyHubToken(token: string, typ: "hub_sso" | "hub_sync" | "hub_meta"): Promise<HubClaims | null> {
  const key = hubPublicKey();
  const aud = hubSystemKey();
  if (!key || !aud || !token) return null;
  let claims: HubClaims;
  try {
    claims = jwt.verify(token, key, { algorithms: ["ES256"], issuer: HUB_ISSUER, audience: aud, maxAge: "120s" }) as HubClaims;
  } catch {
    return null;
  }
  if (claims.typ !== typ || typeof claims.jti !== "string" || !claims.exp) return null;
  const fresh = await query(
    `INSERT INTO hub_used_tokens (jti, expires_at) VALUES ($1, to_timestamp($2)) ON CONFLICT (jti) DO NOTHING RETURNING jti`,
    [claims.jti, claims.exp]
  );
  if (fresh.length === 0) return null; // replayed
  return claims;
}

export function bearer(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}
