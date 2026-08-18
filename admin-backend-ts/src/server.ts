// Must be imported before any routes are registered — patches Express 4 so a
// rejected promise/thrown error inside an async route handler reaches the
// error-handling middleware below via next(err) instead of leaving the
// request hanging forever with no response (Express 4 doesn't do this on its
// own; Express 5 does, but that's a larger upgrade than this fix warrants).
import "express-async-errors";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { authRouter, seedSuperAdmin } from "./routes/auth.routes.js";
import { usersRouter } from "./routes/users.routes.js";
import { companiesRouter, packagesRouter } from "./routes/companies.routes.js";
import { companyPaymentMethodsRouter } from "./routes/companyPaymentMethods.routes.js";
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
import { activityLogRouter } from "./routes/activityLog.routes.js";
import { paymentWalletsRouter } from "./routes/paymentWallets.routes.js";
import { commissionsRouter } from "./routes/commissions.routes.js";
import { simBalancesRouter } from "./routes/simBalances.routes.js";
import { feedbackRouter } from "./routes/feedback.routes.js";
import { referralsRouter } from "./routes/referrals.routes.js";
import { financeRouter } from "./routes/finance.routes.js";
import { exchangeRouter } from "./routes/exchange.routes.js";
import { smsSenderIdsRouter } from "./routes/smsSenderIds.routes.js";
import { somlinkRouter } from "./routes/somlink.routes.js";
import { resellersRouter } from "./routes/resellers.routes.js";
import { resellerOrdersRouter } from "./routes/resellerOrders.routes.js";
import { resellerDepositsWithdrawalsRouter } from "./routes/resellerDepositsWithdrawals.routes.js";
import { pool, queryOne } from "./db/pool.js";
import { seedAll } from "./db/seed.js";
import { sendJson } from "./utils/camelCase.js";

// Express 4 route handlers here are plain `async (req, res) => {...}` with no
// wrapper — a promise rejection inside one (e.g. an uncaught DB error) never
// reaches the error middleware below; it becomes an unhandled rejection at
// the process level, which Node terminates the whole process for by default.
// Attaching this listener is what stops that: Node only hard-crashes on an
// unhandled rejection when *nothing* is listening for it. One bad request
// must never take the entire backend down for every other user.
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("Unhandled rejection (request likely already failed with a response, but the process stays up):", reason);
});

// Static privacy policy page for the DALAB INTERNET Customer App, required
// by the Google Play Console's Store Listing / Data Safety section. Kept as
// an inline constant (no templating, no DB read) since it's public,
// unauthenticated, and changes rarely — a full static-file pipeline would be
// overkill for one page.
const PRIVACY_POLICY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — DALAB INTERNET</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; line-height: 1.6; color: #1a1a2e; }
  h1 { font-size: 1.6rem; }
  h2 { font-size: 1.15rem; margin-top: 2em; }
  p, li { color: #333; }
  .updated { color: #666; font-size: 0.9rem; }
</style>
</head>
<body>
<h1>Privacy Policy — DALAB INTERNET</h1>
<p class="updated">Last updated: 2026-07-31</p>

<p>This Privacy Policy explains how the DALAB INTERNET Customer App ("the App"), provided by WAAPROLTD, collects, uses, stores, and protects information when you use it to purchase and manage internet/data packages.</p>

<h2>Information we collect</h2>
<ul>
  <li><strong>Account information:</strong> your name and phone number, which you provide when creating an account and logging in.</li>
  <li><strong>Login verification:</strong> a one-time passcode (OTP) is sent to your phone number to verify it's really you. The App can read this code from an incoming SMS automatically (see Permissions below) so you don't have to type it in.</li>
  <li><strong>Order and payment information:</strong> the packages you purchase, order status, and payment confirmation details (such as the mobile money transaction reference) needed to verify your payment and deliver your data package.</li>
  <li><strong>Notifications:</strong> in-app notifications about your orders and account, generated by our systems.</li>
  <li><strong>Support messages:</strong> if you contact support (call, WhatsApp, or live chat), the content of that conversation is handled by that channel (e.g. your phone's dialer/WhatsApp) and is not otherwise collected by the App.</li>
</ul>

<h2>Permissions used by the App</h2>
<ul>
  <li><strong>SMS (Receive SMS):</strong> used only to automatically read the one-time login verification code sent to your own phone number, so you don't have to type it manually. The App does not read, store, or transmit any other SMS messages on your device. This permission is optional — if denied, you can still enter the code by hand.</li>
  <li><strong>Internet / Network access:</strong> required for the App to communicate with our servers (loading packages, placing orders, checking order status).</li>
  <li><strong>Phone (dialer):</strong> used only to open your phone's dialer with a payment code pre-filled when you choose to pay — the App does not place calls on your behalf without your action.</li>
</ul>

<h2>How we use your information</h2>
<p>We use the information above solely to operate the App: creating and securing your account, processing and verifying your orders and payments, delivering your purchased data package, showing you your order history, and providing customer support when you request it.</p>
<p>We do not sell your personal information, and we do not use it for advertising or third-party marketing.</p>

<h2>How we store and protect your information</h2>
<p>Your information is stored on secured servers operated on your behalf and protected using encryption in transit (HTTPS). Access to customer data is restricted to authorized personnel who need it to operate the service (for example, to verify a payment or resolve a support request). Sensitive data cached on your device is stored using Android's encrypted storage.</p>

<h2>Data sharing</h2>
<p>We do not share your personal information with third parties, except:</p>
<ul>
  <li>with the mobile network/payment providers involved in processing your own payment and data delivery, to the extent needed to complete your order;</li>
  <li>if required by law, legal process, or to protect the rights, property, or safety of WAAPROLTD, our users, or others.</li>
</ul>
<p>The App does not include third-party advertising or analytics SDKs.</p>

<h2>Data retention</h2>
<p>We retain account and order information for as long as your account is active and as needed to comply with legal, accounting, or dispute-resolution obligations. You may request deletion of your account and associated data at any time from within the App or by contacting support below.</p>

<h2>Children's privacy</h2>
<p>The App is not directed at children and is not knowingly used to collect information from children.</p>

<h2>Changes to this policy</h2>
<p>We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated "Last updated" date.</p>

<h2>Contact us</h2>
<p>If you have questions about this Privacy Policy or your data, contact WAAPROLTD through the support options available in the App.</p>
</body>
</html>
`;

// Static "how to delete your account" page, referenced from the Play
// Console's Data Safety "Delete account URL" field for anyone who needs to
// request deletion without the app installed. In-app deletion (Profile ->
// Delete Account, ApiService.deleteAccount()) already exists and is
// immediate/permanent — this page documents both paths.
const DELETE_ACCOUNT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delete Your Account — DALAB INTERNET</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; line-height: 1.6; color: #1a1a2e; }
  h1 { font-size: 1.6rem; }
  h2 { font-size: 1.15rem; margin-top: 2em; }
  p, li { color: #333; }
</style>
</head>
<body>
<h1>Delete Your Account — DALAB INTERNET</h1>

<h2>Option 1: Delete in the app (immediate)</h2>
<p>Open the DALAB INTERNET app, go to <strong>Profile → Delete Account</strong>, and confirm. Your account is deleted immediately and permanently — this cannot be undone.</p>

<h2>Option 2: Request deletion without the app</h2>
<p>If you no longer have the app installed, contact WAAPROLTD support with the phone number registered on your account and ask for it to be deleted. We will verify your identity and delete your account within a reasonable time.</p>

<h2>What gets deleted</h2>
<p>Your account profile (name and phone number) and login credentials are permanently deleted. Records of completed orders and payments may be retained for a limited period as required for accounting, fraud-prevention, and legal obligations, after which they are also removed.</p>
</body>
</html>
`;

const app = express();

// Render sits in front of this app as a single reverse-proxy hop — trusting
// exactly one hop makes Express resolve req.ip from X-Forwarded-For
// correctly (the proxy's own value, not whatever a client appends), which
// the rate limiter below depends on to not be trivially bypassable.
app.set("trust proxy", 1);

// Fires the instant a request reaches Express, and again when the response
// actually finishes -- if something downstream hangs, the "-->" line still
// proves the request arrived; a missing "<--" line pinpoints that it never
// completed, instead of the total silence today that leaves "did this even
// reach the server" as an open question during an incident. Method+path+
// status+duration only, never headers/body, so nothing sensitive is logged.
// Registered before express.json()/cors() so it's ahead of every other
// possible failure point in the chain.
app.use((req: Request, res: Response, next: NextFunction) => {
  const startedAt = Date.now();
  // eslint-disable-next-line no-console
  console.log(`--> ${req.method} ${req.path}`);
  res.on("finish", () => {
    // eslint-disable-next-line no-console
    console.log(`<-- ${req.method} ${req.path} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

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

app.get("/privacy-policy", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(PRIVACY_POLICY_HTML);
});

app.get("/delete-account", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(DELETE_ACCOUNT_HTML);
});

// Enforces the `maintenance_mode` system setting (previously stored but
// never read). Admin routes always pass through — staff must be able to
// keep managing the system, and to turn maintenance mode back off, while
// it's on. Customer/agent-facing routes get a clear 503 instead of
// whatever half-broken behavior they'd otherwise hit mid-maintenance.
app.use(async (req: Request, res: Response, next: NextFunction) => {
  if (
    req.path.startsWith("/admin") ||
    req.path === "/health" ||
    req.path === "/privacy-policy" ||
    req.path === "/delete-account"
  ) {
    return next();
  }
  const row = await queryOne<{ value: string }>(`SELECT value FROM system_settings WHERE key='maintenance_mode'`);
  if (row?.value === "true") {
    return sendJson(res, 503, { error: "DALAB INTERNET is temporarily under maintenance. Please try again shortly." });
  }
  next();
});

app.use(authRouter);
app.use(usersRouter);
app.use(companiesRouter);
app.use(companyPaymentMethodsRouter);
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
app.use(activityLogRouter);
app.use(paymentWalletsRouter);
app.use(commissionsRouter);
app.use(simBalancesRouter);
app.use(feedbackRouter);
app.use(referralsRouter);
app.use(financeRouter);
app.use(exchangeRouter);
app.use(smsSenderIdsRouter);
app.use(somlinkRouter);
app.use(resellersRouter);
app.use(resellerOrdersRouter);
app.use(resellerDepositsWithdrawalsRouter);

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
