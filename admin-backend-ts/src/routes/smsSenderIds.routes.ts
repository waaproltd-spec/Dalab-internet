import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";

export const smsSenderIdsRouter = Router();

const SENDER_COLUMNS = `id, provider_key, sender, label, enabled, created_at, updated_at`;

/**
 * Agent App — GET /agent/sms-sender-ids, polled and cached in memory
 * (see SmsSenderIdRepository.kt) so PaymentSmsParsers/ExchangePayoutSentParsers
 * can validate an SMS's real sender against the provider it claims to be
 * from, without a network call on SmsReceiver's synchronous main-thread
 * path. Global, not scoped by device/company: sender identity is a
 * property of the telecom network itself, not of any individual
 * number/wallet row (see 045_sms_sender_ids.sql). Only enabled rows.
 */
smsSenderIdsRouter.get("/agent/sms-sender-ids", requireAuth("agent"), async (_req, res) => {
  const rows = await query(
    `SELECT provider_key, sender FROM sms_sender_ids WHERE enabled = true ORDER BY provider_key, sender`
  );
  sendJson(res, 200, rows);
});

smsSenderIdsRouter.get("/admin/sms-sender-ids", requireStaff(), async (_req, res) => {
  const rows = await query(`SELECT ${SENDER_COLUMNS} FROM sms_sender_ids ORDER BY provider_key, sender`);
  sendJson(res, 200, rows);
});

// Super-Admin-exclusive — this directly controls which SMS the Agent App
// trusts as a real payment/payout confirmation, same sensitivity level as
// paymentWallets.routes.ts's/companyPaymentMethods.routes.ts's writes.
smsSenderIdsRouter.post("/admin/sms-sender-ids", requireAuth("super_admin"), async (req, res) => {
  const { providerKey, sender, label } = req.body;
  if (!providerKey || !sender) return sendJson(res, 400, { error: "providerKey and sender are required" });

  const id = randomUUID();
  try {
    await query(
      `INSERT INTO sms_sender_ids (id, provider_key, sender, label) VALUES ($1,$2,$3,$4)`,
      [id, String(providerKey).trim(), String(sender).trim(), label || null]
    );
  } catch (err: any) {
    if (err?.code === "23505") {
      return sendJson(res, 409, { error: `provider "${providerKey}" already has sender "${sender}"` });
    }
    throw err;
  }
  const created = await queryOne(`SELECT ${SENDER_COLUMNS} FROM sms_sender_ids WHERE id=$1`, [id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "create_sms_sender_id",
    entityType: "sms_sender_id",
    entityId: id,
    oldValue: null,
    newValue: created,
  });
  sendJson(res, 201, created);
});

smsSenderIdsRouter.put("/admin/sms-sender-ids/:id/status", requireAuth("super_admin"), async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") return sendJson(res, 400, { error: "enabled must be a boolean" });
  const existing = await queryOne(`SELECT enabled FROM sms_sender_ids WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Sender not found" });
  await query(`UPDATE sms_sender_ids SET enabled=$1, updated_at=now() WHERE id=$2`, [enabled, req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "update_sms_sender_id_status",
    entityType: "sms_sender_id",
    entityId: req.params.id,
    oldValue: { enabled: existing.enabled },
    newValue: { enabled },
  });
  sendJson(res, 200, await queryOne(`SELECT ${SENDER_COLUMNS} FROM sms_sender_ids WHERE id=$1`, [req.params.id]));
});

smsSenderIdsRouter.delete("/admin/sms-sender-ids/:id", requireAuth("super_admin"), async (req, res) => {
  const existing = await queryOne(`SELECT ${SENDER_COLUMNS} FROM sms_sender_ids WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Sender not found" });
  await query(`DELETE FROM sms_sender_ids WHERE id=$1`, [req.params.id]);
  await recordActivity({
    adminId: req.auth!.sub,
    action: "delete_sms_sender_id",
    entityType: "sms_sender_id",
    entityId: req.params.id,
    oldValue: existing,
    newValue: null,
  });
  sendJson(res, 200, { deleted: true });
});
