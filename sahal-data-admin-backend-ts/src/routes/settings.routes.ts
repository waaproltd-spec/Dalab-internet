import { Router } from "express";
import { query } from "../db/pool.js";
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
  app_name: "SAHAL DATA",
  support_phone: "",
  support_email: "",
  otp_length: "4",
  otp_expiry_minutes: "2",
  maintenance_mode: "false",
  macaash_points_per_dollar: "10",
  // Social Media Links (Settings -> Social Media Links). Each link has its
  // own free-text value plus an independent "_enabled" toggle, so a Super
  // Admin can temporarily hide a channel without erasing the configured
  // value. GET /settings/public only ever returns a link when it's both
  // enabled AND has a non-empty value — everything else surfaces as null so
  // the Customer App can hide/disable that button with no guessing.
  social_whatsapp_number: "252610338686",
  social_whatsapp_enabled: "true",
  social_phone_number: "252610338686",
  social_phone_enabled: "true",
  social_facebook_url: "",
  social_facebook_enabled: "true",
  social_instagram_url: "",
  social_instagram_enabled: "true",
  social_tiktok_url: "",
  social_tiktok_enabled: "true",
  social_email: "",
  social_email_enabled: "true",
  social_play_store_url: "https://play.google.com/store/apps/details?id=com.sahal.data.customer",
  social_play_store_enabled: "true",
};

const SOCIAL_LINK_FIELDS = [
  { key: "whatsappNumber", value: "social_whatsapp_number", enabled: "social_whatsapp_enabled" },
  { key: "phoneNumber", value: "social_phone_number", enabled: "social_phone_enabled" },
  { key: "facebookUrl", value: "social_facebook_url", enabled: "social_facebook_enabled" },
  { key: "instagramUrl", value: "social_instagram_url", enabled: "social_instagram_enabled" },
  { key: "tiktokUrl", value: "social_tiktok_url", enabled: "social_tiktok_enabled" },
  { key: "email", value: "social_email", enabled: "social_email_enabled" },
  { key: "playStoreUrl", value: "social_play_store_url", enabled: "social_play_store_enabled" },
] as const;

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
  // e.g. so the Customer App can show the configured support number and
  // social media links.
  const rows = await query<{ key: string; value: string }>(`SELECT key, value FROM system_settings`);
  const merged = { ...DEFAULT_SETTINGS };
  for (const r of rows) merged[r.key] = r.value;

  const socialLinks: Record<string, string | null> = {};
  for (const field of SOCIAL_LINK_FIELDS) {
    const enabled = merged[field.enabled] !== "false";
    const value = merged[field.value]?.trim();
    socialLinks[field.key] = enabled && value ? value : null;
  }

  sendJson(res, 200, {
    appName: merged.app_name,
    supportPhone: merged.support_phone,
    socialLinks,
  });
});
