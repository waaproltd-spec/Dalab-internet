import { verifyToken } from "./crypto.js";

/**
 * Reads `Authorization: Bearer <token>`, verifies it, and checks the token's
 * `role` claim against `allowedRoles`. On success it attaches `ctx.auth =
 * { id, role, ... }` and lets the chain continue; on failure it sends the
 * response itself (401/403) so the route handler never runs.
 *
 * This is the single enforcement point described in the architecture doc,
 * §5a — every /agent/*, /admin/*, and authenticated /customer-ish route uses
 * this, so a customer token can never reach an agent or admin route and vice
 * versa, regardless of how well-formed the rest of the request is.
 */
export function requireAuth(...allowedRoles) {
  return async (ctx) => {
    const header = ctx.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return ctx.json(401, { error: "Missing bearer token" });

    const payload = verifyToken(token);
    if (!payload) return ctx.json(401, { error: "Invalid or expired token" });

    if (allowedRoles.length > 0 && !allowedRoles.includes(payload.role)) {
      return ctx.json(403, { error: `Role '${payload.role}' cannot access this route` });
    }

    ctx.auth = payload; // { sub, role, iat, exp }
  };
}
