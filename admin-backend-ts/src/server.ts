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
import { notificationsRouter } from "./routes/notifications.routes.js";
import { executionLogsRouter } from "./routes/executionLogs.routes.js";
import { pool } from "./db/pool.js";
import { seedAll } from "./db/seed.js";

const app = express();

app.use(express.json());
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
