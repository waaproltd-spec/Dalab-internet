import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";

export const settingsRouter = Router();

/**
 * Simple key/value system configuration store — the "Settings page" module.
 * Anything staff should be able to change without a code deploy goes here:
 * app name, support contact, OTP length/expiry, maintenance mode, etc. Keys
 * are free-form strings rather than a fixed schema, so adding a new setting
 * is just a new row, not a migration.
 */
const DEFAULT_SETTINGS: Record<string, string> = {
  app_name: "DALAB INTERNET",
  support_phone: "",
  support_email: "",
  otp_length: "4",
  otp_expiry_minutes: "2",
  maintenance_mode: "false",
  macaash_points_per_dollar: "10",
};

settingsRouter.get("/admin/settings", requireStaff(), async (_req, res) => {
  const rows = await query<{ key: string; value: string; updated_at: string }>(`SELECT * FROM system_settings`);
  const merged = { ...DEFAULT_SETTINGS };
  for (const row of rows) merged[row.key] = row.value;
  sendJson(res, 200, merged);
});

settingsRouter.put("/admin/settings/:key", requirePermission("settings.manage"), async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  if (typeof value !== "string") return sendJson(res, 400, { error: "value must be a string" });
  if (!(key in DEFAULT_SETTINGS)) {
    return sendJson(res, 400, { error: `Unknown setting key. Known keys: ${Object.keys(DEFAULT_SETTINGS).join(", ")}` });
  }

  await query(
    `INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=now()`,
    [key, value, req.auth!.sub]
  );
  sendJson(res, 200, { key, value });
});

settingsRouter.get("/settings/public", async (_req, res) => {
  // A small subset safe to expose to customer/agent apps without auth —
  // e.g. so the Customer App can show the configured support number.
  const row = await queryOne(`SELECT value FROM system_settings WHERE key='support_phone'`);
  const appName = await queryOne(`SELECT value FROM system_settings WHERE key='app_name'`);
  sendJson(res, 200, {
    appName: appName?.value ?? DEFAULT_SETTINGS.app_name,
    supportPhone: row?.value ?? DEFAULT_SETTINGS.support_phone,
  });
});
