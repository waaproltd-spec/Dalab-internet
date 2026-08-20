import { randomUUID } from "node:crypto";
import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { rateLimit } from "../auth/rateLimit.js";
import { sendJson } from "../utils/camelCase.js";
import { broadcast } from "../realtime/orderEvents.js";

export const supportRouter = Router();

const OPEN_STATUSES = ["queued", "pending", "assigned"];
const SUPPORT_TOPICS = ["dalab_internet", "payment_services", "agent_support"];

// ---------------- Shared helpers ----------------

/** Position (1-based) among every currently 'queued' conversation, oldest first. Null once no longer queued. */
async function queuePositionFor(conversationId: string): Promise<number | null> {
  const row = await queryOne<{ position: string }>(
    `SELECT position FROM (
       SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS position
       FROM support_conversations WHERE status = 'queued'
     ) ranked WHERE ranked.id = $1`,
    [conversationId]
  );
  return row ? Number(row.position) : null;
}

async function serializeConversation(row: any, opts: { includeMessages?: boolean } = {}) {
  const out: Record<string, unknown> = { ...row };
  if (row.status === "queued") {
    const position = await queuePositionFor(row.id);
    out.queuePosition = position;
    out.customersAhead = position !== null ? position - 1 : null;
  } else {
    out.queuePosition = null;
    out.customersAhead = null;
  }
  if (row.agent_id) {
    const agent = await queryOne<{ email: string }>(`SELECT email FROM admin_users WHERE id=$1`, [row.agent_id]);
    out.agentName = agent?.email ?? null;
  } else {
    out.agentName = null;
  }
  if (opts.includeMessages) {
    out.messages = await query(
      `SELECT id, sender_type, body, created_at FROM support_messages WHERE conversation_id=$1 ORDER BY created_at ASC`,
      [row.id]
    );
  }
  return out;
}

// ---------------- Customer-facing ----------------

// Idempotent by design: a customer can only ever have one open (queued /
// pending / assigned) conversation at a time -- enforced twice, once here
// (a plain read, the common case) and again by the DB's own partial unique
// index as the race-proof backstop (see migration 061), so a retried
// request from a flaky connection can never create a duplicate.
supportRouter.post(
  "/support/conversations",
  requireAuth("customer"),
  rateLimit("support-conversation-create", 10, 15 * 60 * 1000),
  async (req, res) => {
    const topic = String(req.body.topic ?? "agent_support");
    if (!SUPPORT_TOPICS.includes(topic)) {
      return sendJson(res, 400, { error: `topic must be one of: ${SUPPORT_TOPICS.join(", ")}` });
    }
    const message = String(req.body.message ?? "").trim();
    if (!message) return sendJson(res, 400, { error: "A message is required to start a support request" });

    const existing = await queryOne(
      `SELECT * FROM support_conversations WHERE customer_id=$1 AND status = ANY($2)`,
      [req.auth!.sub, OPEN_STATUSES]
    );
    if (existing) {
      return sendJson(res, 200, await serializeConversation(existing, { includeMessages: true }));
    }

    // Look for an online agent with nothing currently assigned to them --
    // if found, the customer skips the queue entirely and connects
    // immediately. Otherwise: queued (an agent is online, just busy) or
    // pending (nobody is online at all -- the "leave a message" case).
    const idleAgent = await queryOne<{ admin_id: string }>(
      `SELECT s.admin_id FROM support_agent_status s
       WHERE s.online = true
         AND NOT EXISTS (SELECT 1 FROM support_conversations c WHERE c.agent_id = s.admin_id AND c.status = 'assigned')
       ORDER BY s.updated_at ASC
       LIMIT 1`
    );
    const anyOnline = await queryOne<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM support_agent_status WHERE online = true) AS exists`
    );
    const agentOnline = anyOnline?.exists === true;

    const status = idleAgent ? "assigned" : agentOnline ? "queued" : "pending";
    const id = randomUUID();

    let conversation;
    try {
      const inserted = await query(
        `INSERT INTO support_conversations (id, customer_id, topic, status, agent_id, agent_offline_at_start, assigned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, req.auth!.sub, topic, status, idleAgent?.admin_id ?? null, !agentOnline, status === "assigned" ? new Date() : null]
      );
      conversation = inserted[0];
    } catch (err) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505" && pgErr.constraint === "idx_support_conversations_one_open_per_customer") {
        const raced = await queryOne(`SELECT * FROM support_conversations WHERE customer_id=$1 AND status = ANY($2)`, [
          req.auth!.sub,
          OPEN_STATUSES,
        ]);
        return sendJson(res, 200, await serializeConversation(raced, { includeMessages: true }));
      }
      throw err;
    }

    await query(`INSERT INTO support_messages (id, conversation_id, sender_type, body) VALUES ($1,$2,'customer',$3)`, [
      randomUUID(),
      id,
      message,
    ]);

    broadcast({ type: "support_conversation.updated", conversationId: id });
    sendJson(res, 201, await serializeConversation(conversation, { includeMessages: true }));
  }
);

// The customer app polls this to drive the waiting screen / chat screen --
// null when there's nothing open, so the app knows to show the 3 support
// cards again. Survives the app being closed and reopened: this is a pure
// read of server state, there is no client-side-only queue position.
supportRouter.get("/support/conversations/mine", requireAuth("customer"), async (req, res) => {
  const conversation = await queryOne(
    `SELECT * FROM support_conversations WHERE customer_id=$1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 1`,
    [req.auth!.sub, OPEN_STATUSES]
  );
  if (!conversation) return sendJson(res, 200, null);
  sendJson(res, 200, await serializeConversation(conversation, { includeMessages: true }));
});

supportRouter.post(
  "/support/conversations/:id/messages",
  requireAuth("customer"),
  rateLimit("support-message-send", 30, 5 * 60 * 1000),
  async (req, res) => {
    const body = String(req.body.message ?? "").trim();
    if (!body) return sendJson(res, 400, { error: "Message cannot be empty" });

    const conversation = await queryOne(`SELECT * FROM support_conversations WHERE id=$1 AND customer_id=$2`, [
      req.params.id,
      req.auth!.sub,
    ]);
    if (!conversation) return sendJson(res, 404, { error: "Conversation not found" });
    if (!OPEN_STATUSES.includes(conversation.status)) {
      return sendJson(res, 409, { error: "This conversation is closed" });
    }

    await query(`INSERT INTO support_messages (id, conversation_id, sender_type, body) VALUES ($1,$2,'customer',$3)`, [
      randomUUID(),
      req.params.id,
      body,
    ]);
    await query(`UPDATE support_conversations SET updated_at=now() WHERE id=$1`, [req.params.id]);

    broadcast({ type: "support_conversation.updated", conversationId: req.params.id });
    sendJson(res, 201, await serializeConversation(conversation, { includeMessages: true }));
  }
);

// Only while queued/pending -- once an agent has actually picked it up the
// natural end is the agent resolving/closing it, matching where the "Cancel"
// button is specced to appear (the pre-assignment waiting screen only).
supportRouter.post("/support/conversations/:id/cancel", requireAuth("customer"), async (req, res) => {
  const rows = await query(
    `UPDATE support_conversations SET status='closed', closed_at=now(), updated_at=now()
     WHERE id=$1 AND customer_id=$2 AND status IN ('queued','pending') RETURNING id`,
    [req.params.id, req.auth!.sub]
  );
  if (rows.length === 0) {
    return sendJson(res, 409, { error: "Conversation not found, not yours, or already being handled" });
  }
  broadcast({ type: "support_conversation.updated", conversationId: req.params.id });
  sendJson(res, 200, { id: req.params.id, status: "closed" });
});

// A small, deliberately static FAQ -- never a generative call, and never
// anything that could look like it knows this customer's own balance,
// orders, or account status (per the product requirement: AI must not
// invent that kind of information). Anything not confidently matched here
// is the app's cue to hand off to the real queue via POST /support/conversations.
const SUPPORT_FAQ: { keywords: string[]; answer: string }[] = [
  { keywords: ["evc", "evc plus"], answer: "EVC Plus is Hormuud's mobile money wallet. Choose it as your payment method and follow the USSD prompt to complete payment." },
  { keywords: ["how long", "how much time", "delivery time"], answer: "Most internet/data orders are delivered within a few minutes of a confirmed payment. If it's been longer, an agent can check the specific order for you." },
  { keywords: ["macaash", "points", "loyalty"], answer: "Macaash points are DALAB's loyalty points, earned on qualifying purchases and usable as a discount on a future order." },
  { keywords: ["change password", "reset password", "forgot password"], answer: "You can reset your password from the login screen using \"Forgot password\" — you'll need your registered phone number." },
  { keywords: ["what is dalab", "what does dalab", "about dalab"], answer: "DALAB Internet lets you buy internet/data packages, exchange money, and manage your wallet, all from one app." },
];

supportRouter.post("/support/ai-assist", requireAuth("customer"), async (req, res) => {
  const question = String(req.body.question ?? "").trim().toLowerCase();
  const match = question ? SUPPORT_FAQ.find((f) => f.keywords.some((k) => question.includes(k))) : undefined;
  sendJson(res, 200, { answered: !!match, answer: match?.answer ?? null });
});

// ---------------- Agent-facing (Admin Dashboard) ----------------

supportRouter.get("/admin/support/status", requirePermission("support.manage"), async (req, res) => {
  const status = await queryOne<{ online: boolean }>(`SELECT online FROM support_agent_status WHERE admin_id=$1`, [
    req.auth!.sub,
  ]);
  const active = await queryOne(`SELECT id FROM support_conversations WHERE agent_id=$1 AND status='assigned'`, [
    req.auth!.sub,
  ]);
  sendJson(res, 200, { online: status?.online ?? false, activeConversationId: active?.id ?? null });
});

supportRouter.put("/admin/support/status", requirePermission("support.manage"), async (req, res) => {
  const online = Boolean(req.body.online);
  await query(
    `INSERT INTO support_agent_status (admin_id, online, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (admin_id) DO UPDATE SET online=$2, updated_at=now()`,
    [req.auth!.sub, online]
  );

  if (!online) {
    // Never drop the conversation -- free it back into the assignable pool
    // (queued/pending, whichever the next claim-next call would prefer is
    // irrelevant: both are eligible) so the next available agent picks it
    // up, all messages intact.
    const reassigned = await query<{ id: string }>(
      `UPDATE support_conversations SET status='pending', agent_id=NULL, updated_at=now()
       WHERE agent_id=$1 AND status='assigned' RETURNING id`,
      [req.auth!.sub]
    );
    for (const row of reassigned) {
      await query(`INSERT INTO support_messages (id, conversation_id, sender_type, body) VALUES ($1,$2,'system',$3)`, [
        randomUUID(),
        row.id,
        "The agent went offline. You'll be connected to the next available agent.",
      ]);
      broadcast({ type: "support_conversation.updated", conversationId: row.id });
    }
  }

  sendJson(res, 200, { online });
});

supportRouter.get("/admin/support/queue", requirePermission("support.manage"), async (req, res) => {
  const rows = await query(
    `SELECT c.*, cu.name AS customer_name, cu.phone AS customer_phone,
            (SELECT body FROM support_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at ASC LIMIT 1) AS first_message
     FROM support_conversations c
     JOIN customers cu ON cu.id = c.customer_id
     WHERE c.status IN ('queued','pending')
     ORDER BY c.created_at ASC`
  );
  sendJson(res, 200, rows);
});

supportRouter.get("/admin/support/conversations/:id", requirePermission("support.manage"), async (req, res) => {
  const conversation = await queryOne(
    `SELECT c.*, cu.name AS customer_name, cu.phone AS customer_phone
     FROM support_conversations c JOIN customers cu ON cu.id = c.customer_id
     WHERE c.id=$1`,
    [req.params.id]
  );
  if (!conversation) return sendJson(res, 404, { error: "Conversation not found" });
  sendJson(res, 200, await serializeConversation(conversation, { includeMessages: true }));
});

// The single atomic "give me the oldest waiting customer" claim -- same
// FOR UPDATE SKIP LOCKED-on-the-candidate-row idiom used for every other
// work queue in this codebase (see smsLogs/resellerSmsMatching/orders
// matching), so two agents hitting this at the same instant can never both
// walk away with the same customer.
async function claimNextForAgent(adminId: string) {
  return queryOne(
    `UPDATE support_conversations SET status='assigned', agent_id=$1, assigned_at=now(), updated_at=now()
     WHERE id = (
       SELECT id FROM support_conversations
       WHERE status IN ('queued','pending')
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [adminId]
  );
}

supportRouter.post("/admin/support/claim-next", requirePermission("support.manage"), async (req, res) => {
  const status = await queryOne<{ online: boolean }>(`SELECT online FROM support_agent_status WHERE admin_id=$1`, [
    req.auth!.sub,
  ]);
  if (!status?.online) return sendJson(res, 409, { error: "Go online before claiming a conversation" });

  const alreadyActive = await queryOne(`SELECT id FROM support_conversations WHERE agent_id=$1 AND status='assigned'`, [
    req.auth!.sub,
  ]);
  if (alreadyActive) return sendJson(res, 409, { error: "Finish your current conversation first" });

  const claimed = await claimNextForAgent(req.auth!.sub);
  if (!claimed) return sendJson(res, 200, { claimed: null });

  broadcast({ type: "support_conversation.updated", conversationId: claimed.id });
  sendJson(res, 200, { claimed: await serializeConversation(claimed, { includeMessages: true }) });
});

// Claim one specific waiting conversation (the dashboard lets an agent pick
// a particular customer out of the list, not just always take the oldest).
supportRouter.post("/admin/support/conversations/:id/claim", requirePermission("support.manage"), async (req, res) => {
  const status = await queryOne<{ online: boolean }>(`SELECT online FROM support_agent_status WHERE admin_id=$1`, [
    req.auth!.sub,
  ]);
  if (!status?.online) return sendJson(res, 409, { error: "Go online before claiming a conversation" });

  const alreadyActive = await queryOne(`SELECT id FROM support_conversations WHERE agent_id=$1 AND status='assigned'`, [
    req.auth!.sub,
  ]);
  if (alreadyActive) return sendJson(res, 409, { error: "Finish your current conversation first" });

  const claimed = await queryOne(
    `UPDATE support_conversations SET status='assigned', agent_id=$1, assigned_at=now(), updated_at=now()
     WHERE id=$2 AND status IN ('queued','pending') RETURNING *`,
    [req.auth!.sub, req.params.id]
  );
  if (!claimed) return sendJson(res, 409, { error: "This conversation was already claimed or is no longer waiting" });

  broadcast({ type: "support_conversation.updated", conversationId: claimed.id });
  sendJson(res, 200, await serializeConversation(claimed, { includeMessages: true }));
});

supportRouter.post("/admin/support/conversations/:id/messages", requirePermission("support.manage"), async (req, res) => {
  const body = String(req.body.message ?? "").trim();
  if (!body) return sendJson(res, 400, { error: "Message cannot be empty" });

  const conversation = await queryOne(`SELECT * FROM support_conversations WHERE id=$1`, [req.params.id]);
  if (!conversation) return sendJson(res, 404, { error: "Conversation not found" });
  if (conversation.agent_id !== req.auth!.sub) {
    return sendJson(res, 403, { error: "This conversation is assigned to a different agent" });
  }
  if (conversation.status !== "assigned") {
    return sendJson(res, 409, { error: "This conversation is not active" });
  }

  await query(
    `INSERT INTO support_messages (id, conversation_id, sender_type, sender_admin_id, body) VALUES ($1,$2,'agent',$3,$4)`,
    [randomUUID(), req.params.id, req.auth!.sub, body]
  );
  await query(`UPDATE support_conversations SET updated_at=now() WHERE id=$1`, [req.params.id]);

  broadcast({ type: "support_conversation.updated", conversationId: req.params.id });
  sendJson(res, 201, await serializeConversation(conversation, { includeMessages: true }));
});

/**
 * Shared by /resolve and /close: ends the agent's current conversation, then
 * immediately tries to hand them the next oldest waiting one — "when the
 * agent finishes, the next waiting customer should automatically become
 * available" (spec), done server-side rather than requiring a separate
 * manual claim from the dashboard.
 */
async function endConversationAndAutoClaim(
  id: string,
  adminId: string,
  finalStatus: "resolved" | "closed"
): Promise<{ ok: true; next: any } | { ok: false }> {
  const timestampColumn = finalStatus === "resolved" ? "resolved_at" : "closed_at";
  const ended = await queryOne(
    `UPDATE support_conversations SET status=$1, ${timestampColumn}=now(), updated_at=now()
     WHERE id=$2 AND agent_id=$3 AND status='assigned' RETURNING id`,
    [finalStatus, id, adminId]
  );
  if (!ended) return { ok: false };
  broadcast({ type: "support_conversation.updated", conversationId: id });

  const next = await claimNextForAgent(adminId);
  if (next) broadcast({ type: "support_conversation.updated", conversationId: next.id });
  return { ok: true, next };
}

supportRouter.post("/admin/support/conversations/:id/resolve", requirePermission("support.manage"), async (req, res) => {
  const result = await endConversationAndAutoClaim(req.params.id, req.auth!.sub, "resolved");
  if (!result.ok) return sendJson(res, 409, { error: "Conversation not found, not yours, or not active" });
  sendJson(res, 200, {
    ended: true,
    next: result.next ? await serializeConversation(result.next, { includeMessages: true }) : null,
  });
});

supportRouter.post("/admin/support/conversations/:id/close", requirePermission("support.manage"), async (req, res) => {
  const result = await endConversationAndAutoClaim(req.params.id, req.auth!.sub, "closed");
  if (!result.ok) return sendJson(res, 409, { error: "Conversation not found, not yours, or not active" });
  sendJson(res, 200, {
    ended: true,
    next: result.next ? await serializeConversation(result.next, { includeMessages: true }) : null,
  });
});

// ---------------- 1-hour waiting-queue timeout sweep ----------------
// A 'queued' conversation (live position shown to the customer) that ages
// past an hour with no agent free is demoted to 'pending' -- never
// deleted, message history untouched -- so the customer app switches from
// a live position to "an agent will respond when available". Runs on a
// timer at module load, mirroring orderEvents.ts's own self-starting
// heartbeat interval; safe to import this module more than once since ES
// modules are cached, so the interval only actually starts once.
const SUPPORT_QUEUE_TIMEOUT_SWEEP_MS = 60_000;
setInterval(async () => {
  try {
    const expired = await query<{ id: string }>(
      `UPDATE support_conversations SET status='pending', updated_at=now()
       WHERE status='queued' AND created_at < now() - interval '1 hour'
       RETURNING id`
    );
    for (const row of expired) {
      await query(`INSERT INTO support_messages (id, conversation_id, sender_type, body) VALUES ($1,$2,'system',$3)`, [
        randomUUID(),
        row.id,
        "No agent became available within an hour. An agent will respond to you as soon as one is available.",
      ]);
      broadcast({ type: "support_conversation.updated", conversationId: row.id });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Support queue timeout sweep failed:", (err as Error).message);
  }
}, SUPPORT_QUEUE_TIMEOUT_SWEEP_MS);
