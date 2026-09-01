import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";

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
  app_slogan: "Internet you can trust.",
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
  social_play_store_url: "https://play.google.com/store/apps/details?id=com.dalab.internet.customer",
  social_play_store_enabled: "true",
  social_telegram_url: "",
  social_telegram_enabled: "true",
  social_website_url: "",
  social_website_enabled: "true",
  // Customer App home screen's three top-level services (Internet, eBadal,
  // Reseller) -- purely a customer-facing visibility toggle, never a
  // backend/database disable: turning one off only hides its card on
  // GET /settings/public's consumers, every order/route/table underneath it
  // keeps working exactly as before (an existing session already inside
  // that service, or a direct API call, is completely unaffected). Each key
  // is independent -- toggling one never touches the other two. Defaults to
  // "true" so a customer on today's build (before any admin ever visits
  // this setting) sees exactly what they see now: all three services.
  service_internet_enabled: "true",
  service_ebadal_enabled: "true",
  service_reseller_enabled: "true",
  service_shop_enabled: "true",
};

const SOCIAL_LINK_FIELDS = [
  { key: "whatsappNumber", value: "social_whatsapp_number", enabled: "social_whatsapp_enabled" },
  { key: "phoneNumber", value: "social_phone_number", enabled: "social_phone_enabled" },
  { key: "facebookUrl", value: "social_facebook_url", enabled: "social_facebook_enabled" },
  { key: "instagramUrl", value: "social_instagram_url", enabled: "social_instagram_enabled" },
  { key: "tiktokUrl", value: "social_tiktok_url", enabled: "social_tiktok_enabled" },
  { key: "telegramUrl", value: "social_telegram_url", enabled: "social_telegram_enabled" },
  { key: "websiteUrl", value: "social_website_url", enabled: "social_website_enabled" },
  { key: "email", value: "social_email", enabled: "social_email_enabled" },
  { key: "playStoreUrl", value: "social_play_store_url", enabled: "social_play_store_enabled" },
] as const;

// Format validation for the settings a Super Admin can type free text into —
// every OTHER key (app_name, otp_length, maintenance_mode, ...) keeps its
// existing "any string" behavior; only phone/URL/email-shaped fields gain a
// check, and only when non-empty (blank always means "not configured" and
// is always valid — these are optional fields).
const PHONE_SETTING_KEYS = new Set(["social_whatsapp_number", "social_phone_number", "support_phone"]);
const URL_SETTING_KEYS = new Set([
  "social_facebook_url",
  "social_instagram_url",
  "social_tiktok_url",
  "social_telegram_url",
  "social_website_url",
  "social_play_store_url",
]);
const EMAIL_SETTING_KEYS = new Set(["social_email", "support_email"]);

const PHONE_PATTERN = /^\+?\d{6,15}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateSettingValue(key: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (PHONE_SETTING_KEYS.has(key) && !PHONE_PATTERN.test(trimmed)) {
    return "Enter a valid phone number (digits only, optionally starting with +).";
  }
  if (URL_SETTING_KEYS.has(key)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      return "Enter a valid URL starting with http:// or https://.";
    }
  }
  if (EMAIL_SETTING_KEYS.has(key) && !EMAIL_PATTERN.test(trimmed)) {
    return "Enter a valid email address.";
  }
  return null;
}

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
  const validationError = validateSettingValue(key, value);
  if (validationError) return sendJson(res, 400, { error: validationError });

  // Read the row that's actually about to change (not DEFAULT_SETTINGS) so
  // the audit log's oldValue reflects the real prior state, including a
  // prior override that happens to equal the default.
  const existing = await queryOne<{ value: string }>(`SELECT value FROM system_settings WHERE key=$1`, [key]);
  const oldValue = existing?.value ?? DEFAULT_SETTINGS[key];

  await query(
    `INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=now()`,
    [key, value, req.auth!.sub]
  );
  if (oldValue !== value) {
    await recordActivity({
      adminId: req.auth!.sub,
      action: "setting_updated",
      entityType: "system_setting",
      entityId: key,
      oldValue,
      newValue: value,
    });
  }
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
    // Fails safe (visible) on anything but the literal string "false" --
    // an unset/missing/malformed value must never hide a service that was
    // never actually turned off.
    services: {
      internetEnabled: merged.service_internet_enabled !== "false",
      ebadalEnabled: merged.service_ebadal_enabled !== "false",
      resellerEnabled: merged.service_reseller_enabled !== "false",
      shopEnabled: merged.service_shop_enabled !== "false",
    },
  });
});
