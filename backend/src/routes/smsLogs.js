import { randomUUID } from "node:crypto";
import { requireAuth } from "../auth/middleware.js";

/**
 * Somali phone numbers legitimately appear in multiple formats depending on
 * where they were typed/parsed from: with the 252 country code, with a
 * leading 0, or bare. "252699000444", "0699000444", and "699000444" are the
 * same subscriber. Comparing raw strings would silently fail to match even
 * the objectively correct pairing, so every phone comparison in matching
 * goes through this first — take the last 9 digits (the actual subscriber
 * number) after stripping everything else.
 */
function normalizePhone(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.slice(-9);
}

/**
 * Matches a parsed payment SMS to a pending order.
 *
 * Cross-network by design: the telecom that RECEIVED the payment (Hormuud
 * EVC Plus, eDahab, whichever) has no bearing on which PROVIDER's order it
 * fulfills — a customer can pay via any network for a package on any other
 * network. So this deliberately does NOT filter candidate orders by
 * parsedProvider/company_id (an earlier version of this function did — that
 * was the bug: it silently required the payment's telecom to match the
 * order's telecom, which is exactly backwards per the spec).
 *
 * Matching strategy:
 *   amount (small tolerance) + customer phone, compared via normalizePhone()
 *   so format differences between how the order stored the number and how
 *   the SMS parser extracted it don't cause a false miss. If no phone was
 *   extracted, or nothing matches both amount and phone, this deliberately
 *   returns null rather than falling back to an amount-only guess across
 *   possibly-different customers — for a payments system, an unmatched SMS
 *   sitting in the admin's manual-review queue
 *   (GET /admin/sms-logs?matched=false) is far safer than auto-assigning a
 *   payment to the wrong customer.
 */
function findMatchingOrder(db, { parsedAmount, parsedPhone }) {
  if (parsedAmount == null || !parsedPhone) return null;
  const targetPhone = normalizePhone(parsedPhone);
  if (!targetPhone) return null;

  const candidates = db.prepare(
    `SELECT id, sender_phone FROM orders WHERE status = 'pending' AND ABS(amount - ?) < 0.01 ORDER BY created_at ASC`
  ).all(parsedAmount);

  return candidates.find((o) => normalizePhone(o.sender_phone) === targetPhone) ?? null;
}

export function registerSmsLogRoutes(app, db) {
  app.post("/agent/sms-logs", requireAuth("agent"), async (ctx) => {
    const { sender, body, parsedProvider, parsedAmount, parsedPhone, receivedAt } = ctx.body;
    if (!sender || !body) return ctx.json(400, { error: "sender and body are required" });

    const match = findMatchingOrder(db, { parsedAmount, parsedPhone });
    const id = randomUUID();
    db.prepare(
      `INSERT INTO sms_logs (id, agent_id, sender, body, parsed_provider, parsed_amount, parsed_phone, matched_order_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
    ).run(id, ctx.auth.sub, sender, body, parsedProvider ?? null, parsedAmount ?? null, parsedPhone ?? null,
          match?.id ?? null, receivedAt ?? null);

    ctx.json(201, { id, matchedOrderId: match?.id ?? null });
  });

  app.get("/admin/sms-logs", requireAuth("super_admin"), async (ctx) => {
    const { agentId, matched } = ctx.query;
    let sql = `SELECT * FROM sms_logs WHERE 1=1`;
    const args = [];
    if (agentId) { sql += ` AND agent_id = ?`; args.push(agentId); }
    if (matched === "true") sql += ` AND matched_order_id IS NOT NULL`;
    if (matched === "false") sql += ` AND matched_order_id IS NULL`;
    sql += ` ORDER BY received_at DESC`;
    ctx.json(200, db.prepare(sql).all(...args));
  });
}
