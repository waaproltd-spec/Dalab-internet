import { Request, Response, NextFunction } from "express";

/**
 * A minimal in-memory sliding-window rate limiter — no dependency needed for
 * this. Keyed by IP + route, so one abusive client hammering /admin/auth/login
 * doesn't affect a different client hitting /auth/otp/request.
 *
 * Real limitation, stated plainly: in-memory state means limits reset on a
 * restart/redeploy, and don't share state across multiple server instances.
 * That's an acceptable tradeoff for Render's free tier (one instance) but
 * genuinely not correct once this backend runs on more than one instance —
 * at that point this needs a shared store (Redis) instead. Noted here
 * rather than silently shipping something that looks production-ready but
 * quietly isn't once you scale horizontally.
 */
const attempts = new Map<string, number[]>();

export function rateLimit(routeKey: string, maxAttempts: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ?? req.socket?.remoteAddress ?? "unknown";
    const key = `${routeKey}:${ip}`;
    const now = Date.now();

    const existing = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
    if (existing.length >= maxAttempts) {
      res.status(429).json({ error: "Too many attempts. Please try again later." });
      return;
    }

    existing.push(now);
    attempts.set(key, existing);
    next();
  };
}

// Cheap, bounded cleanup so `attempts` never grows unbounded on a long-lived
// process — runs occasionally, not on every request.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // drop anything older than 1 hour
  for (const [key, timestamps] of attempts.entries()) {
    const kept = timestamps.filter((t) => t > cutoff);
    if (kept.length === 0) attempts.delete(key);
    else attempts.set(key, kept);
  }
}, 15 * 60 * 1000);
