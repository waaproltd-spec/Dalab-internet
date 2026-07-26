import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./http/router.js";
import { openDb } from "./db/index.js";
import { seedCatalog, seedUssdTemplates, seedAgentDevices } from "./db/seed.js";
import { registerAuthRoutes, seedAdminAndAgent } from "./routes/auth.js";
import { registerCompanyRoutes, registerPackageRoutes } from "./routes/companies.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerCustomerRoutes } from "./routes/customers.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerMacaashRoutes } from "./routes/macaash.js";
import { registerBannerRoutes } from "./routes/banners.js";
import { registerSmsLogRoutes } from "./routes/smsLogs.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerUssdRoutes } from "./routes/ussd.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function buildServer({ dbPath } = {}) {
  if (dbPath) process.env.DB_PATH = dbPath;
  else mkdirSync(path.join(__dirname, "../data"), { recursive: true });

  const db = openDb();
  seedCatalog(db);
  seedAdminAndAgent(db);
  seedUssdTemplates(db);
  seedAgentDevices(db);

  const app = createApp();

  registerAuthRoutes(app, db);
  registerCompanyRoutes(app, db);
  registerPackageRoutes(app, db);
  registerOrderRoutes(app, db);
  registerCustomerRoutes(app, db);
  registerAgentRoutes(app, db);
  registerMacaashRoutes(app, db);
  registerBannerRoutes(app, db);
  registerSmsLogRoutes(app, db);
  registerNotificationRoutes(app, db);
  registerReportRoutes(app, db);
  registerUssdRoutes(app, db);

  app.get("/health", async (ctx) => ctx.json(200, { status: "ok", time: new Date().toISOString() }));

  return { app, db };
}

// Only auto-start when run directly (`node src/server.js`), not when imported
// by the test suite, which builds its own server on an ephemeral port instead.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { app } = buildServer();
  const port = process.env.PORT ?? 4000;
  app.listen(port, () => {
    console.log(`DALAB INTERNET API listening on http://localhost:${port}`);
    console.log(`Admin login:  aarandata33@gmail.com / Yaas120@`);
    console.log(`Agent login:  252610000001 / AgentPass123!`);
  });
}
