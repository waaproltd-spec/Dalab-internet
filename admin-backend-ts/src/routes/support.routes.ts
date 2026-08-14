import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { answerCustomerQuestion } from "../support/supportAi.js";
import { subscribe, broadcast } from "../realtime/orderEvents.js";

export const supportRouter = Router();

function generateTicketNumber(): string {
  return "SUP" + Math.floor(100000000 + Math.random() * 900000000);
}

// Exact copy shown to the customer the moment a human takes over — this
// wording is a product requirement, not just a placeholder.
function handoffMessage(queue: "agent" | "admin"): string {
  const who = queue === "admin" ? "Admin" : "Agent";
  return `Fadlan sug, codsigaaga waxaa hadda xallinaya ${who}.`;
}

interface TicketRow {
  id: string;
  ticket_number: string;
  customer_id: string;
  queue: "agent" | "admin";
  status: "waiting" | "in_progress" | "resolved";
  subject: string;
  assigned_agent_id: string | null;
  assigned_admin_id: string | null;
  created_at: string;
  accepted_at: string | null;
  resolved_at: string | null;
}

// Position/ETA are computed live from current queue state on every request
// rather than stored — "updates automatically as customers are served" then
// falls out for free: a ticket's position only ever reflects how many
// still-waiting tickets in the same queue were created before it.
async function queueInfo(t: Pick<TicketRow, "id" | "queue" | "status">): Promise<{ position: number; etaMinutes: number } | null> {
  if (t.status !== "waiting") return null;
  // Compares against the row's own created_at via a subquery rather than
  // passing t.created_at back as a bind parameter -- Postgres timestamps
  // carry microsecond precision but a JS Date only holds milliseconds, so a
  // round-tripped value came back very slightly earlier than what's
  // actually stored and made a ticket fail to count as <= itself (position
  // 0 for the very first ticket in an empty queue).
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(*) AS n FROM support_tickets
     WHERE queue=$1 AND status='waiting'
       AND created_at <= (SELECT created_at FROM support_tickets WHERE id=$2)`,
    [t.queue, t.id]
  );
  const position = Number(row?.n ?? 1);
  return { position, etaMinutes: position }; // 1 waiting -> ~1 min, 10 waiting -> ~10 min, per spec
}

async function loadMessages(ticketId: string) {
  return query(
    `SELECT id, sender_type, sender_id, body, created_at FROM support_messages WHERE ticket_id=$1 ORDER BY created_at ASC`,
    [ticketId]
  );
}

async function ticketResponse(t: TicketRow) {
  return { ...t, queueInfo: await queueInfo(t), messages: await loadMessages(t.id) };
}

// ==================== Customer ====================

// AI-first attempt -- no ticket is created here. A confident match answers
// immediately and the conversation ends there; an unmatched question
// returns matched:false so the app can offer Agent/Admin escalation. Never
// guesses: see supportAi.ts's own doc comment for why this is a keyword
// matcher against real data, not a generative model.
supportRouter.post("/customer/support/ask", requireAuth("customer"), async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) return sendJson(res, 400, { error: "message is required" });
  const result = await answerCustomerQuestion(req.auth!.sub, message);
  if (!result) return sendJson(res, 200, { matched: false });
  sendJson(res, 200, { matched: true, answer: result.answer, intent: result.intent });
});

// Escalates to a human queue. `history` carries whatever the customer/AI
// already exchanged in this session (each {senderType: 'customer'|'ai',
// body}) so the Agent/Admin who picks it up has full context instead of
// starting blind.
supportRouter.post("/customer/support/tickets", requireAuth("customer"), async (req, res) => {
  const { queue, subject, history } = req.body ?? {};
  if (queue !== "agent" && queue !== "admin") return sendJson(res, 400, { error: "queue must be 'agent' or 'admin'" });
  const subjectText = String(subject ?? "").trim().slice(0, 500) || "Caawimaad la codsaday";

  // A customer can only have one open (non-resolved) ticket at a time --
  // prevents duplicate queue entries from a double-tap or a retried request.
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM support_tickets WHERE customer_id=$1 AND status != 'resolved' LIMIT 1`,
    [req.auth!.sub]
  );
  if (existing) return sendJson(res, 409, { error: "You already have an open support request", ticketId: existing.id });

  const ticket = await queryOne<TicketRow>(
    `INSERT INTO support_tickets (ticket_number, customer_id, queue, subject)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [generateTicketNumber(), req.auth!.sub, queue, subjectText]
  );
  const historyArr = Array.isArray(history) ? history : [];
  for (const entry of historyArr) {
    const senderType = entry?.senderType === "ai" ? "ai" : "customer";
    const body = String(entry?.body ?? "").trim();
    if (!body) continue;
    await query(`INSERT INTO support_messages (ticket_id, sender_type, body) VALUES ($1,$2,$3)`, [ticket!.id, senderType, body]);
  }
  await query(`INSERT INTO support_messages (ticket_id, sender_type, body) VALUES ($1,'system',$2)`, [
    ticket!.id,
    queue === "admin" ? "Codsigan waxaa loo gudbiyay Admin." : "Codsigan waxaa loo gudbiyay Agent.",
  ]);
  broadcast({ type: "support_ticket.updated", ticketId: ticket!.id, queue });
  sendJson(res, 201, await ticketResponse(ticket!));
});

// The customer's own currently-open ticket, if any -- lets the app resume
// straight into the queue/chat view on relaunch instead of losing state.
supportRouter.get("/customer/support/tickets/active", requireAuth("customer"), async (req, res) => {
  const ticket = await queryOne<TicketRow>(
    `SELECT * FROM support_tickets WHERE customer_id=$1 AND status != 'resolved' ORDER BY created_at DESC LIMIT 1`,
    [req.auth!.sub]
  );
  if (!ticket) return sendJson(res, 200, { ticket: null });
  sendJson(res, 200, { ticket: await ticketResponse(ticket) });
});

supportRouter.get("/customer/support/tickets/:id", requireAuth("customer"), async (req, res) => {
  const ticket = await queryOne<TicketRow>(`SELECT * FROM support_tickets WHERE id=$1 AND customer_id=$2`, [req.params.id, req.auth!.sub]);
  if (!ticket) return sendJson(res, 404, { error: "Ticket not found" });
  sendJson(res, 200, await ticketResponse(ticket));
});

supportRouter.post("/customer/support/tickets/:id/messages", requireAuth("customer"), async (req, res) => {
  const body = String(req.body?.body ?? "").trim();
  if (!body) return sendJson(res, 400, { error: "body is required" });
  const ticket = await queryOne<TicketRow>(`SELECT * FROM support_tickets WHERE id=$1 AND customer_id=$2`, [req.params.id, req.auth!.sub]);
  if (!ticket) return sendJson(res, 404, { error: "Ticket not found" });
  if (ticket.status === "resolved") return sendJson(res, 409, { error: "This ticket is already resolved" });
  await query(`INSERT INTO support_messages (ticket_id, sender_type, sender_id, body) VALUES ($1,'customer',$2,$3)`, [
    ticket.id,
    req.auth!.sub,
    body,
  ]);
  await query(`UPDATE support_tickets SET updated_at=now() WHERE id=$1`, [ticket.id]);
  broadcast({ type: "support_ticket.updated", ticketId: ticket.id, queue: ticket.queue });
  sendJson(res, 201, await ticketResponse(ticket));
});

// Real-time queue-position/chat updates for the Customer App -- reuses the
// exact same subscribe/broadcast pub/sub already powering order streams;
// clients just refetch on any event rather than trusting the payload.
supportRouter.get("/customer/support/stream", requireAuth("customer"), async (req, res) => {
  const unsubscribe = subscribe(res);
  req.on("close", unsubscribe);
});

// ==================== Shared accept/message/resolve logic (Agent + Admin) ====================

async function acceptTicket(ticketId: string, queue: "agent" | "admin", assignedCol: "assigned_agent_id" | "assigned_admin_id", userId: string) {
  // Atomic compare-and-swap, same pattern as every other status transition
  // in this codebase -- only the FIRST accept wins if two staff members tap
  // Accept at the same moment; the loser gets 0 rows back, not an error.
  const rows = await query<TicketRow>(
    `UPDATE support_tickets SET status='in_progress', ${assignedCol}=$1, accepted_at=now(), updated_at=now()
     WHERE id=$2 AND queue=$3 AND status='waiting' RETURNING *`,
    [userId, ticketId, queue]
  );
  if (rows.length === 0) return null;
  const ticket = rows[0];
  await query(`INSERT INTO support_messages (ticket_id, sender_type, body) VALUES ($1,'system',$2)`, [ticket.id, handoffMessage(queue)]);
  broadcast({ type: "support_ticket.updated", ticketId: ticket.id, queue: ticket.queue });
  return ticket;
}

async function postStaffMessage(ticketId: string, senderType: "agent" | "admin", userId: string, assignedCol: string, body: string) {
  const ticket = await queryOne<TicketRow>(`SELECT * FROM support_tickets WHERE id=$1 AND ${assignedCol}=$2`, [ticketId, userId]);
  if (!ticket) return null;
  if (ticket.status === "resolved") return "resolved" as const;
  await query(`INSERT INTO support_messages (ticket_id, sender_type, sender_id, body) VALUES ($1,$2,$3,$4)`, [
    ticket.id,
    senderType,
    userId,
    body,
  ]);
  await query(`UPDATE support_tickets SET updated_at=now() WHERE id=$1`, [ticket.id]);
  broadcast({ type: "support_ticket.updated", ticketId: ticket.id, queue: ticket.queue });
  return ticket;
}

async function resolveTicket(ticketId: string, assignedCol: string, userId: string) {
  const rows = await query<TicketRow>(
    `UPDATE support_tickets SET status='resolved', resolved_at=now(), updated_at=now()
     WHERE id=$1 AND ${assignedCol}=$2 AND status != 'resolved' RETURNING *`,
    [ticketId, userId]
  );
  if (rows.length === 0) return null;
  const ticket = rows[0];
  await query(`INSERT INTO support_messages (ticket_id, sender_type, body) VALUES ($1,'system','Codsigan waa la xalliyay.')`, [ticket.id]);
  broadcast({ type: "support_ticket.updated", ticketId: ticket.id, queue: ticket.queue });
  return ticket;
}

const QUEUE_LIST_SELECT = `
  SELECT st.*, COALESCE(c.name, c.phone) AS customer_name,
         (SELECT body FROM support_messages sm WHERE sm.ticket_id=st.id AND sm.sender_type IN ('customer','ai') ORDER BY sm.created_at DESC LIMIT 1) AS last_message,
         EXTRACT(EPOCH FROM (now() - st.created_at)) / 60 AS waiting_minutes
  FROM support_tickets st JOIN customers c ON c.id = st.customer_id
`;

// ==================== Agent ====================

// Waiting tickets in the shared agent queue, plus whatever this agent has
// already accepted and is still working -- once accepted a ticket drops out
// of every OTHER agent's waiting view (the WHERE clause below only ever
// returns status='waiting' rows, which an accepted ticket no longer is).
supportRouter.get("/agent/support/tickets", requireAuth("agent"), async (req, res) => {
  const rows = await query(
    `${QUEUE_LIST_SELECT} WHERE st.queue='agent' AND (st.status='waiting' OR (st.status='in_progress' AND st.assigned_agent_id=$1))
     ORDER BY (st.status='waiting') DESC, st.created_at ASC`,
    [req.auth!.sub]
  );
  sendJson(res, 200, rows);
});

supportRouter.post("/agent/support/tickets/:id/accept", requireAuth("agent"), async (req, res) => {
  const ticket = await acceptTicket(req.params.id, "agent", "assigned_agent_id", req.auth!.sub);
  if (!ticket) return sendJson(res, 409, { error: "This request was already accepted" });
  sendJson(res, 200, await ticketResponse(ticket));
});

supportRouter.post("/agent/support/tickets/:id/messages", requireAuth("agent"), async (req, res) => {
  const body = String(req.body?.body ?? "").trim();
  if (!body) return sendJson(res, 400, { error: "body is required" });
  const result = await postStaffMessage(req.params.id, "agent", req.auth!.sub, "assigned_agent_id", body);
  if (!result) return sendJson(res, 404, { error: "Ticket not found or not assigned to you" });
  if (result === "resolved") return sendJson(res, 409, { error: "This ticket is already resolved" });
  sendJson(res, 200, await ticketResponse(result));
});

supportRouter.post("/agent/support/tickets/:id/resolve", requireAuth("agent"), async (req, res) => {
  const ticket = await resolveTicket(req.params.id, "assigned_agent_id", req.auth!.sub);
  if (!ticket) return sendJson(res, 404, { error: "Ticket not found, not assigned to you, or already resolved" });
  sendJson(res, 200, await ticketResponse(ticket));
});

supportRouter.get("/agent/support/stream", requireAuth("agent"), async (req, res) => {
  const unsubscribe = subscribe(res);
  req.on("close", unsubscribe);
});

// ==================== Admin ====================

supportRouter.get("/admin/support/tickets", requireStaff(), async (req, res) => {
  const rows = await query(
    `${QUEUE_LIST_SELECT} WHERE st.queue='admin' AND (st.status='waiting' OR (st.status='in_progress' AND st.assigned_admin_id=$1))
     ORDER BY (st.status='waiting') DESC, st.created_at ASC`,
    [req.auth!.sub]
  );
  sendJson(res, 200, rows);
});

supportRouter.post("/admin/support/tickets/:id/accept", requireStaff(), async (req, res) => {
  const ticket = await acceptTicket(req.params.id, "admin", "assigned_admin_id", req.auth!.sub);
  if (!ticket) return sendJson(res, 409, { error: "This request was already accepted" });
  sendJson(res, 200, await ticketResponse(ticket));
});

supportRouter.post("/admin/support/tickets/:id/messages", requireStaff(), async (req, res) => {
  const body = String(req.body?.body ?? "").trim();
  if (!body) return sendJson(res, 400, { error: "body is required" });
  const result = await postStaffMessage(req.params.id, "admin", req.auth!.sub, "assigned_admin_id", body);
  if (!result) return sendJson(res, 404, { error: "Ticket not found or not assigned to you" });
  if (result === "resolved") return sendJson(res, 409, { error: "This ticket is already resolved" });
  sendJson(res, 200, await ticketResponse(result));
});

supportRouter.post("/admin/support/tickets/:id/resolve", requireStaff(), async (req, res) => {
  const ticket = await resolveTicket(req.params.id, "assigned_admin_id", req.auth!.sub);
  if (!ticket) return sendJson(res, 404, { error: "Ticket not found, not assigned to you, or already resolved" });
  sendJson(res, 200, await ticketResponse(ticket));
});
