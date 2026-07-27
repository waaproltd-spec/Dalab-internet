import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { authRouter, seedSuperAdmin } from "./routes/auth.routes.js";
import { usersRouter } from "./routes/users.routes.js";
import { companiesRouter, packagesRouter } from "./routes/companies.routes.js";
import { categoriesRouter } from "./routes/categories.routes.js";
import { ordersRouter } from "./routes/orders.routes.js";
import { customersRouter } from "./routes/customers.routes.js";
import { agentsRouter } from "./routes/agents.routes.js";
import { smsLogsRouter } from "./routes/smsLogs.routes.js";
import { reportsRouter } from "./routes/reports.routes.js";
import { settingsRouter } from "./routes/settings.routes.js";
import { ussdRouter } from "./routes/ussd.routes.js";
import { macaashRouter } from "./routes/macaash.routes.js";
import { bannersRouter } from "./routes/banners.routes.js";
import { promoImagesRouter } from "./routes/promoImages.routes.js";
import { notificationsRouter } from "./routes/notifications.routes.js";
import { executionLogsRouter } from "./routes/executionLogs.routes.js";
import { pool } from "./db/pool.js";
import { seedAll } from "./db/seed.js";

const app = express();

// Render sits in front of this app as a single reverse-proxy hop — trusting
// exactly one hop makes Express resolve req.ip from X-Forwarded-For
// correctly (the proxy's own value, not whatever a client appends), which
// the rate limiter below depends on to not be trivially bypassable.
app.set("trust proxy", 1);

if (!process.env.CORS_ORIGIN && process.env.NODE_ENV === "production") {
  throw new Error("CORS_ORIGIN is not set. Refusing to start in production wide open to any origin.");
}

// Default 100kb limit is far too small for base64-encoded promo images
// (POST /admin/promo-images) — everything else on this API is small JSON,
// so raising the limit process-wide is simpler than a per-route override.
app.use(express.json({ limit: "8mb" }));
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : "*",
  })
);

// Minimal security headers inline rather than pulling in helmet as a
// dependency — same protections that matter most for a JSON API (no
// framing, no MIME sniffing), without adding another package to audit.
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  // Render always serves this app over HTTPS (TLS terminates at their edge),
  // so this is safe to send unconditionally rather than only when req.secure.
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ok", database: "connected", time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: "error", database: "unreachable", detail: (err as Error).message });
  }
});

app.use(authRouter);
app.use(usersRouter);
app.use(companiesRouter);
app.use(packagesRouter);
app.use(categoriesRouter);
app.use(ordersRouter);
app.use(customersRouter);
app.use(agentsRouter);
app.use(smsLogsRouter);
app.use(reportsRouter);
app.use(settingsRouter);
app.use(ussdRouter);
app.use(macaashRouter);
app.use(bannersRouter);
app.use(promoImagesRouter);
app.use(notificationsRouter);
app.use(executionLogsRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = Number(process.env.PORT ?? 4000);

async function start() {
  try {
    await seedSuperAdmin();
    await seedAll();
  } catch (err) {
    // Don't crash the whole server if seeding fails (e.g. DB not migrated
    // yet on first boot) — log it clearly so it's visible in Render's logs.
    // eslint-disable-next-line no-console
    console.error("Seeding failed (has `npm run migrate` been run?):", err);
  }
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`DALAB Admin API listening on port ${PORT}`);
  });
}

start();

export default app;
