import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";

export const paymentWalletsRouter = Router();

const WALLET_COLUMNS = `id, name, provider_label, dial_prefix, logo_key, color_hex, enabled, sort_order, created_at, updated_at`;

/**
 * Public — the Customer App's "Select Payment Method" sheet must always
 * reflect Super Admin changes immediately, so it fetches this on every
 * checkout rather than caching a hardcoded wallet list. Only enabled
 * wallets are returned; the payment number/USSD string is still built from
 * the purchased company's own payment_number (see companies.routes.ts) —
 * wallets here only carry the dial prefix + display info, never a number.
 */
paymentWalletsRouter.get("/payment-wallets", async (_req, res) => {
  const rows = await query(
    `SELECT ${WALLET_COLUMNS} FROM payment_wallets WHERE enabled=true ORDER BY sort_order, name`
  );
  sendJson(res, 200, rows);
});

paymentWalletsRouter.get("/admin/payment-wallets", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT ${WALLET_COLUMNS} FROM payment_wallets ORDER BY sort_order, name`));
});

// Super-Admin-exclusive, same reasoning as companies.routes.ts's
// payment-number/status routes — this directly controls what the Customer
// App dials, so it isn't delegable via a companies.manage-style permission.
paymentWalletsRouter.post("/admin/payment-wallets", requireAuth("super_admin"), async (req, res) => {
  const { id, name, providerLabel, dialPrefix, logoKey, colorHex, sortOrder } = req.body;
  if (!id || !name || !dialPrefix || !logoKey) {
    return sendJson(res, 400, { error: "id, name, dialPrefix, logoKey are required" });
  }
  if (!/^\d{1,6}$/.test(String(dialPrefix))) {
    return sendJson(res, 400, { error: "dialPrefix must be 1-6 digits" });
  }
  const existing = await queryOne(`SELECT id FROM payment_wallets WHERE id=$1`, [id]);
  if (existing) return sendJson(res, 409, { error: "A wallet with this id already exists" });
  await query(
    `INSERT INTO payment_wallets (id, name, provider_label, dial_prefix, logo_key, color_hex, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, name, providerLabel ?? null, dialPrefix, logoKey, colorHex ?? "#16A34A", sortOrder ?? 0]
  );
  const created = await queryOne(`SELECT ${WALLET_COLUMNS} FROM payment_wallets WHERE id=$1`, [id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "create_payment_wallet",
    entityType: "payment_wallet",
    entityId: id,
    oldValue: null,
    newValue: created,
  });
  sendJson(res, 201, created);
});

paymentWalletsRouter.put("/admin/payment-wallets/:id", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM payment_wallets WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Wallet not found" });
  const dialPrefix = req.body.dialPrefix ?? existing.dial_prefix;
  if (!/^\d{1,6}$/.test(String(dialPrefix))) {
    return sendJson(res, 400, { error: "dialPrefix must be 1-6 digits" });
  }
  const merged = {
    name: req.body.name ?? existing.name,
    providerLabel: req.body.providerLabel ?? existing.provider_label,
    dialPrefix,
    logoKey: req.body.logoKey ?? existing.logo_key,
    colorHex: req.body.colorHex ?? existing.color_hex,
    sortOrder: req.body.sortOrder ?? existing.sort_order,
  };
  await query(
    `UPDATE payment_wallets SET name=$1, provider_label=$2, dial_prefix=$3, logo_key=$4, color_hex=$5, sort_order=$6, updated_at=now() WHERE id=$7`,
    [merged.name, merged.providerLabel, merged.dialPrefix, merged.logoKey, merged.colorHex, merged.sortOrder, req.params.id]
  );
  const updated = await queryOne(`SELECT ${WALLET_COLUMNS} FROM payment_wallets WHERE id=$1`, [req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_payment_wallet",
    entityType: "payment_wallet",
    entityId: req.params.id,
    oldValue: existing,
    newValue: updated,
  });
  sendJson(res, 200, updated);
});

paymentWalletsRouter.put("/admin/payment-wallets/:id/status", requireAuth("super_admin"), async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") return sendJson(res, 400, { error: "enabled must be a boolean" });
  const existing = await queryOne(`SELECT enabled FROM payment_wallets WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Wallet not found" });
  await query(`UPDATE payment_wallets SET enabled=$1, updated_at=now() WHERE id=$2`, [enabled, req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_payment_wallet_status",
    entityType: "payment_wallet",
    entityId: req.params.id,
    oldValue: { enabled: existing.enabled },
    newValue: { enabled },
  });
  sendJson(res, 200, await queryOne(`SELECT ${WALLET_COLUMNS} FROM payment_wallets WHERE id=$1`, [req.params.id]));
});

paymentWalletsRouter.delete("/admin/payment-wallets/:id", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne(`SELECT ${WALLET_COLUMNS} FROM payment_wallets WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Wallet not found" });
  await query(`DELETE FROM payment_wallets WHERE id=$1`, [req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "delete_payment_wallet",
    entityType: "payment_wallet",
    entityId: req.params.id,
    oldValue: existing,
    newValue: null,
  });
  sendJson(res, 200, { deleted: true });
});
