import { Router, Request } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import {
  SMS_FORMAT_PROVIDERS,
  SmsFormatProvider,
  SmsFormatRule,
  FieldChoice,
  Candidates,
  providerByKey,
  detectCandidates,
  defaultChoice,
  generateRule,
  suggestKeywords,
  validateRule,
  applyRule,
  findConflicts,
  loadActiveFormats,
  clearSmsFormatCache,
  normalizeSms,
  MAX_SMS_LENGTH,
} from "../utils/smsFormats.js";

/**
 * SMS Format Update (Super Admin): paste a provider's new payment SMS, test
 * what it reads, then save & activate it. Every save is a new version; the
 * previous one stays in history and can be restored. The Agent App picks up
 * the active formats from GET /agent/sms-formats (no app update needed), and
 * the backend reads SMS that an older app uploaded unparsed with the same
 * formats (ingestPaymentSms). Reading an SMS never marks anything paid by
 * itself -- the normal matching/verification pipeline still decides.
 */
export const smsFormatsRouter = Router();

const RULE_COLUMNS = `r.id, r.provider, r.version, r.sample_sms, r.pattern, r.amount_group, r.sender_group, r.reference_group,
  r.recipient_group, r.keywords, r.senders, r.extracted, r.note, r.status, r.created_at, r.activated_at,
  cu.email AS created_by_email, au.email AS activated_by_email`;

async function sendersFor(provider: SmsFormatProvider): Promise<string[]> {
  const rows = await query<{ sender: string }>(
    `SELECT sender FROM sms_sender_ids WHERE provider_key=$1 AND enabled=true ORDER BY sender`,
    [provider.senderKey]
  );
  return rows.length > 0 ? rows.map((r) => r.sender) : provider.defaultSenders;
}

function cleanList(value: unknown, max = 10): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => String(v).trim()).filter((v) => v.length > 0 && v.length <= 80).slice(0, max);
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

type TestOutcome = {
  ok: boolean;
  error: string | null;
  provider: string;
  parsedProvider: string;
  candidates: { amounts: string[]; phones: string[]; references: string[] };
  choice: FieldChoice;
  rule: SmsFormatRule;
  extracted: { amount: number; senderPhone: string; reference: string | null; recipientPhone: string | null } | null;
  conflicts: string[];
  warnings: string[];
};

/**
 * The single place a format is tested -- used by Test SMS, and again on the
 * server by Save & Activate and Restore, so nothing can be activated without
 * passing it.
 */
async function runTest(body: any): Promise<{ status: number; outcome?: TestOutcome; error?: string }> {
  const provider = providerByKey(body?.provider);
  if (!provider) return { status: 400, error: "Choose a payment provider." };
  const sms = typeof body?.sms === "string" ? body.sms : "";
  if (!sms.trim()) return { status: 400, error: "Paste the full SMS first." };
  if (sms.length > MAX_SMS_LENGTH) return { status: 400, error: `The SMS is too long (max ${MAX_SMS_LENGTH} characters).` };

  const candidates: Candidates = detectCandidates(sms);
  const auto = defaultChoice(candidates);
  const pick = (v: unknown, fallback: number) => (Number.isInteger(v) ? (v as number) : fallback);
  const choice: FieldChoice = {
    amountIndex: pick(body?.choice?.amountIndex, auto.amountIndex),
    senderIndex: pick(body?.choice?.senderIndex, auto.senderIndex),
    referenceIndex: pick(body?.choice?.referenceIndex, auto.referenceIndex),
    recipientIndex: pick(body?.choice?.recipientIndex, auto.recipientIndex),
  };

  const keywords = cleanList(body?.keywords) ?? suggestKeywords(sms, candidates.amounts[choice.amountIndex]);
  const senders = cleanList(body?.senders) ?? (await sendersFor(provider));

  let rule: SmsFormatRule;
  let error: string | null = null;
  const customPattern = typeof body?.pattern === "string" && body.pattern.trim() ? body.pattern.trim() : null;
  if (customPattern) {
    rule = {
      pattern: customPattern,
      amountGroup: intOrNull(body?.amountGroup) as number,
      senderGroup: intOrNull(body?.senderGroup) as number,
      referenceGroup: intOrNull(body?.referenceGroup),
      recipientGroup: intOrNull(body?.recipientGroup),
      keywords,
      senders,
    };
  } else {
    const generated = generateRule(sms, candidates, choice);
    rule = { ...generated.rule, keywords, senders };
    error = generated.error ?? null;
  }

  let extracted: TestOutcome["extracted"] = null;
  let conflicts: string[] = [];
  if (!error) error = validateRule(rule);
  if (!error) {
    const result = applyRule(rule, sms);
    if (result.ok) extracted = result.extracted;
    else error = `The SMS could not be read: ${result.reason}`;
  }
  if (!error) {
    const otherActive = (await loadActiveFormats()).filter((f) => f.provider !== provider.key);
    conflicts = findConflicts(provider, rule, normalizeSms(sms), otherActive);
  }

  const warnings: string[] = [];
  if (extracted && !extracted.reference) {
    warnings.push("No transaction reference was read. Duplicate protection will rely on the sender, text and time of each SMS.");
  }
  if (candidates.amounts.length > 1) {
    warnings.push(`This SMS has ${candidates.amounts.length} amounts (${candidates.amounts.map((a) => a.value).join(", ")}). Check that Amount is the payment, not the balance.`);
  }

  return {
    status: 200,
    outcome: {
      ok: !error && conflicts.length === 0,
      error,
      provider: provider.key,
      parsedProvider: provider.parsedProvider,
      candidates: {
        amounts: candidates.amounts.map((a) => a.value),
        phones: candidates.phones.map((p) => p.value),
        references: candidates.references.map((r) => r.value),
      },
      choice,
      rule,
      extracted,
      conflicts,
      warnings,
    },
  };
}

async function logEvent(ruleId: string | null, provider: string, action: string, adminId: string, details: unknown, client?: any) {
  const sql = `INSERT INTO sms_format_rule_events (id, rule_id, provider, action, admin_id, details) VALUES ($1,$2,$3,$4,$5,$6)`;
  const params = [randomUUID(), ruleId, provider, action, adminId, JSON.stringify(details ?? null)];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

/**
 * SMS uploaded unparsed in the last 24h (before this format existed) that
 * this format can read: fill in what it reads so the regular 15s resweep
 * matches and verifies them like any other payment. An SMS whose
 * transaction reference was already processed is left alone.
 */
async function backfillRecentSms(rule: SmsFormatRule & { provider: string; version: number }): Promise<number> {
  const provider = providerByKey(rule.provider)!;
  const senders = rule.senders.map((s) => s.trim().toLowerCase());
  const rows = await query<{ id: string; sender: string; body: string }>(
    `SELECT id, sender, body FROM sms_logs
      WHERE parsed_amount IS NULL AND received_at > now() - interval '24 hours'
        AND matched_order_id IS NULL AND matched_exchange_order_id IS NULL AND matched_reseller_deposit_id IS NULL
        AND matched_reseller_withdrawal_id IS NULL AND matched_vip_number_order_id IS NULL
        AND matched_vip_number_package_order_id IS NULL AND matched_shop_order_id IS NULL
        AND lower(trim(sender)) = ANY($1::text[])
      ORDER BY received_at ASC LIMIT 500`,
    [senders]
  );
  let filled = 0;
  for (const row of rows) {
    const result = applyRule(rule, row.body ?? "");
    if (!result.ok) continue;
    const { amount, senderPhone, reference } = result.extracted;
    if (reference) {
      const seen = await queryOne(`SELECT id FROM sms_logs WHERE transaction_ref=$1 AND id<>$2`, [reference, row.id]);
      if (seen) {
        await query(`UPDATE sms_logs SET match_failure_reason=$1 WHERE id=$2`, [
          `Already processed: transaction reference ${reference} belongs to another SMS`,
          row.id,
        ]);
        continue;
      }
    }
    try {
      const updated = await query(
        `UPDATE sms_logs SET parsed_provider=$1, parsed_amount=$2, parsed_phone=$3, transaction_ref=COALESCE(transaction_ref,$4),
                match_failure_reason=$5
          WHERE id=$6 AND parsed_amount IS NULL RETURNING id`,
        [provider.parsedProvider, amount, senderPhone, reference, `Read by SMS format v${rule.version}; waiting for payment matching`, row.id]
      );
      if (updated.length === 0) continue;
    } catch (err: any) {
      if (err?.code === "23505") continue; // the same reference raced in -- already processed
      throw err;
    }
    try {
      await query(
        `UPDATE payment_transactions SET amount=$1, customer_phone=$2, transaction_ref=COALESCE(transaction_ref,$3), updated_at=now()
          WHERE sms_log_id=$4 AND order_id IS NULL AND status='pending'`,
        [amount, senderPhone, reference, row.id]
      );
    } catch (err: any) {
      if (err?.code !== "23505") throw err;
      await query(
        `UPDATE payment_transactions SET amount=$1, customer_phone=$2, updated_at=now() WHERE sms_log_id=$3 AND order_id IS NULL AND status='pending'`,
        [amount, senderPhone, row.id]
      );
    }
    filled++;
  }
  return filled;
}

async function activate(req: Request, ruleId: string, provider: string, action: "activated" | "restored", details: Record<string, unknown>) {
  const previous = await withTransaction(async (client) => {
    const prev = await client.query(
      `UPDATE sms_format_rules SET status='inactive' WHERE provider=$1 AND status='active' AND id<>$2 RETURNING id, version`,
      [provider, ruleId]
    );
    await client.query(`UPDATE sms_format_rules SET status='active', activated_by=$1, activated_at=now() WHERE id=$2`, [req.auth!.sub, ruleId]);
    const prevRow = prev.rows[0] ?? null;
    await logEvent(ruleId, provider, action, req.auth!.sub, { ...details, replacedVersion: prevRow?.version ?? null }, client);
    return prevRow;
  });
  clearSmsFormatCache();
  return previous;
}

async function overview() {
  const providers = await Promise.all(
    SMS_FORMAT_PROVIDERS.map(async (p) => ({ key: p.key, label: p.label, parsedProvider: p.parsedProvider, senders: await sendersFor(p) }))
  );
  const rules = await query(
    `SELECT ${RULE_COLUMNS} FROM sms_format_rules r
       LEFT JOIN admin_users cu ON cu.id = r.created_by
       LEFT JOIN admin_users au ON au.id = r.activated_by
      ORDER BY r.provider, r.version DESC`
  );
  const events = await query(
    `SELECT e.id, e.rule_id, e.provider, e.action, e.details, e.created_at, a.email AS admin_email, r.version
       FROM sms_format_rule_events e
       LEFT JOIN admin_users a ON a.id = e.admin_id
       LEFT JOIN sms_format_rules r ON r.id = e.rule_id
      ORDER BY e.created_at DESC LIMIT 200`
  );
  return { providers, rules, events };
}

smsFormatsRouter.get("/admin/sms-formats", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await overview());
});

smsFormatsRouter.post("/admin/sms-formats/test", requireAuth("super_admin"), async (req, res) => {
  const { status, outcome, error } = await runTest(req.body);
  if (!outcome) return sendJson(res, status, { error });
  sendJson(res, 200, outcome);
});

smsFormatsRouter.post("/admin/sms-formats", requireAuth("super_admin"), async (req, res) => {
  const { status, outcome, error } = await runTest(req.body);
  if (!outcome) return sendJson(res, status, { error });
  if (!outcome.ok) {
    return sendJson(res, 422, {
      error: outcome.error ?? outcome.conflicts[0] ?? "This format did not pass its test.",
      test: outcome,
    });
  }
  const provider = outcome.provider;
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 300) || null : null;
  const id = randomUUID();
  const rule = outcome.rule;
  const version = await withTransaction(async (client) => {
    // Serialize versions per provider.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('sms_format_rules:' || $1))`, [provider]);
    const next = await client.query(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM sms_format_rules WHERE provider=$1`, [provider]);
    const v = Number(next.rows[0].v);
    await client.query(
      `INSERT INTO sms_format_rules (id, provider, version, sample_sms, pattern, amount_group, sender_group, reference_group, recipient_group,
                                     keywords, senders, extracted, note, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'inactive',$14)`,
      [
        id, provider, v, req.body.sms, rule.pattern, rule.amountGroup, rule.senderGroup, rule.referenceGroup, rule.recipientGroup,
        JSON.stringify(rule.keywords), JSON.stringify(rule.senders), JSON.stringify(outcome.extracted), note, req.auth!.sub,
      ]
    );
    await logEvent(id, provider, "created", req.auth!.sub, { version: v, note }, client);
    return v;
  });
  const previous = await activate(req, id, provider, "activated", { version });
  await recordActivity({
    adminId: req.auth!.sub,
    action: "sms_format.activated",
    entityType: "sms_format_rule",
    entityId: id,
    oldValue: previous ? { activeVersion: previous.version } : null,
    newValue: { provider, version, pattern: rule.pattern, keywords: rule.keywords, senders: rule.senders },
  });
  const recentSmsRead = await backfillRecentSms({ ...rule, provider, version });
  sendJson(res, 201, { id, provider, version, recentSmsRead, test: outcome });
});

smsFormatsRouter.post("/admin/sms-formats/:id/activate", requireAuth("super_admin"), async (req, res) => {
  const row = await queryOne<any>(`SELECT * FROM sms_format_rules WHERE id=$1`, [req.params.id]);
  if (!row) return sendJson(res, 404, { error: "Format not found" });
  if (row.status === "active") return sendJson(res, 409, { error: "This format is already active." });
  // Re-test the stored version exactly as saved before it goes live again.
  const { outcome } = await runTest({
    provider: row.provider,
    sms: row.sample_sms,
    pattern: row.pattern,
    amountGroup: row.amount_group,
    senderGroup: row.sender_group,
    referenceGroup: row.reference_group,
    recipientGroup: row.recipient_group,
    keywords: row.keywords,
    senders: row.senders,
  });
  if (!outcome?.ok) {
    return sendJson(res, 422, { error: outcome?.error ?? outcome?.conflicts[0] ?? "This format no longer passes its test.", test: outcome });
  }
  const previous = await activate(req, row.id, row.provider, "restored", { version: row.version });
  await recordActivity({
    adminId: req.auth!.sub,
    action: "sms_format.restored",
    entityType: "sms_format_rule",
    entityId: row.id,
    oldValue: previous ? { activeVersion: previous.version } : null,
    newValue: { provider: row.provider, version: row.version },
  });
  const recentSmsRead = await backfillRecentSms({
    pattern: row.pattern,
    amountGroup: row.amount_group,
    senderGroup: row.sender_group,
    referenceGroup: row.reference_group,
    recipientGroup: row.recipient_group,
    keywords: row.keywords,
    senders: row.senders,
    provider: row.provider,
    version: row.version,
  });
  sendJson(res, 200, { id: row.id, provider: row.provider, version: row.version, recentSmsRead });
});

smsFormatsRouter.post("/admin/sms-formats/providers/:provider/deactivate", requireAuth("super_admin"), async (req, res) => {
  const provider = providerByKey(req.params.provider);
  if (!provider) return sendJson(res, 404, { error: "Unknown provider" });
  const rows = await query<{ id: string; version: number }>(
    `UPDATE sms_format_rules SET status='inactive' WHERE provider=$1 AND status='active' RETURNING id, version`,
    [provider.key]
  );
  if (rows.length === 0) return sendJson(res, 404, { error: `${provider.label} has no active custom format.` });
  await logEvent(rows[0].id, provider.key, "deactivated", req.auth!.sub, { version: rows[0].version });
  clearSmsFormatCache();
  await recordActivity({
    adminId: req.auth!.sub,
    action: "sms_format.deactivated",
    entityType: "sms_format_rule",
    entityId: rows[0].id,
    oldValue: { provider: provider.key, activeVersion: rows[0].version },
    newValue: null,
  });
  sendJson(res, 200, { provider: provider.key, deactivatedVersion: rows[0].version });
});

/** Agent App: the active formats, applied before the built-in parsers. */
smsFormatsRouter.get("/agent/sms-formats", requireAuth("agent"), async (_req, res) => {
  const formats = await loadActiveFormats();
  sendJson(
    res,
    200,
    formats.map((f) => ({
      id: f.id,
      provider: f.provider,
      parsedProvider: providerByKey(f.provider)?.parsedProvider ?? null,
      version: f.version,
      pattern: f.pattern,
      amountGroup: f.amountGroup,
      senderGroup: f.senderGroup,
      referenceGroup: f.referenceGroup,
      recipientGroup: f.recipientGroup,
      keywords: f.keywords,
      senders: f.senders,
    }))
  );
});
