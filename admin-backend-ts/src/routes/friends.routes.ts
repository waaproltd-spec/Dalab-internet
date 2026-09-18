import { randomUUID } from "node:crypto";
import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { rateLimit } from "../auth/rateLimit.js";
import { sendJson } from "../utils/camelCase.js";
import { notifyCustomer } from "../services/customerNotify.js";

// Private Friend system -- see 104_customer_friends.sql for the schema this
// is built on. The one hard rule threaded through every route below: there
// is NO way to discover another customer except by already knowing their
// exact Friend ID. No listing, no name search, no "people you may know" --
// GET .../search returns at most the single exact match, everything else
// 404s indistinguishably from "wrong code" and "customer doesn't exist".
export const friendsRouter = Router();

const FRIEND_CODE_PATTERN = /^DALAB-[A-Z0-9]{4}$/;

/** Uppercases, strips whitespace, and adds the "DALAB-" prefix back if a
 * customer typed/pasted just the bare 4-character suffix -- forgiving of
 * exactly the kind of copy-paste slip a real customer makes, while still
 * requiring the full canonical shape before it's ever compared to a row. */
function normalizeFriendCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let code = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (code && !code.startsWith("DALAB-") && /^[A-Z0-9]{4}$/.test(code)) {
    code = `DALAB-${code}`;
  }
  return FRIEND_CODE_PATTERN.test(code) ? code : null;
}

interface PublicFriendProfile {
  id: string;
  name: string | null;
  friend_code: string;
}

async function findByFriendCode(code: string): Promise<PublicFriendProfile | null> {
  return queryOne<PublicFriendProfile>(
    `SELECT id, name, friend_code FROM customers WHERE friend_code=$1 AND status='active'`,
    [code]
  );
}

type RelationshipStatus = "none" | "pending_outgoing" | "pending_incoming" | "friends" | "blocked";

/** The one live (non-terminal-history) row between two customers, if any --
 * 'declined'/'cancelled' requests are deliberately excluded so a past
 * decline/cancel never blocks trying again later. */
async function liveRequestBetween(a: string, b: string) {
  return queryOne<{ id: string; requester_id: string; recipient_id: string; status: string }>(
    `SELECT id, requester_id, recipient_id, status FROM friend_requests
     WHERE status IN ('pending','accepted','blocked')
       AND ((requester_id=$1 AND recipient_id=$2) OR (requester_id=$2 AND recipient_id=$1))
     ORDER BY created_at DESC LIMIT 1`,
    [a, b]
  );
}

function relationshipStatusFor(row: { requester_id: string; status: string } | null, myId: string): RelationshipStatus {
  if (!row) return "none";
  if (row.status === "accepted") return "friends";
  if (row.status === "blocked") return "blocked";
  return row.requester_id === myId ? "pending_outgoing" : "pending_incoming";
}

// The list/detail queries below resolve "the other party" with
// OTHER_PARTY_ID_SQL, a CASE keyed off the bound $1 (always myId) rather
// than any string interpolation of the id itself -- every value that
// reaches SQL text here is a parameter placeholder, never raw input.
const OTHER_PARTY_ID_SQL = `CASE WHEN fr.requester_id=$1 THEN fr.recipient_id ELSE fr.requester_id END`;

// ---------------- Search (the ONLY discovery path in this feature) ----------------

friendsRouter.get(
  "/customer/friends/search",
  requireAuth("customer"),
  rateLimit("friend-search", 20, 60_000),
  async (req, res) => {
    const code = normalizeFriendCode(req.query.code);
    if (!code) return sendJson(res, 400, { error: "Enter a valid Friend ID, e.g. DALAB-7K29" });

    const me = await queryOne<{ friend_code: string }>(`SELECT friend_code FROM customers WHERE id=$1`, [req.auth!.sub]);
    if (me?.friend_code === code) {
      return sendJson(res, 400, { error: "That's your own Friend ID -- share it with a friend instead." });
    }

    const target = await findByFriendCode(code);
    if (!target) return sendJson(res, 404, { error: "No customer found with that Friend ID." });

    const existing = await liveRequestBetween(req.auth!.sub, target.id);
    sendJson(res, 200, {
      id: target.id,
      name: target.name,
      friendCode: target.friend_code,
      relationshipStatus: relationshipStatusFor(existing, req.auth!.sub),
      // The underlying friend_requests row id, when one already exists (any
      // non-'none' relationshipStatus) -- lets the client act on it (cancel
      // an outgoing request, open the existing chat, etc.) without a second
      // round trip to re-discover it.
      requestId: existing?.id ?? null,
    });
  }
);

// ---------------- Friend requests ----------------

friendsRouter.post(
  "/customer/friends/requests",
  requireAuth("customer"),
  rateLimit("friend-request-create", 20, 60_000),
  async (req, res) => {
    const code = normalizeFriendCode(req.body?.friendCode);
    if (!code) return sendJson(res, 400, { error: "Enter a valid Friend ID, e.g. DALAB-7K29" });

    const me = await queryOne<{ id: string; name: string | null; friend_code: string }>(
      `SELECT id, name, friend_code FROM customers WHERE id=$1`,
      [req.auth!.sub]
    );
    if (me?.friend_code === code) {
      return sendJson(res, 400, { error: "That's your own Friend ID -- share it with a friend instead." });
    }

    const target = await findByFriendCode(code);
    if (!target) return sendJson(res, 404, { error: "No customer found with that Friend ID." });

    const existing = await liveRequestBetween(req.auth!.sub, target.id);
    if (existing?.status === "accepted") return sendJson(res, 409, { error: "You are already friends with this customer." });
    if (existing?.status === "blocked") return sendJson(res, 409, { error: "This customer is not available to add." });
    if (existing?.status === "pending") {
      return sendJson(res, 409, {
        error:
          existing.requester_id === req.auth!.sub
            ? "You already sent a friend request to this customer."
            : "This customer already sent you a friend request -- respond to it instead.",
      });
    }

    let created;
    try {
      created = await queryOne<{ id: string; created_at: string }>(
        `INSERT INTO friend_requests (id, requester_id, recipient_id) VALUES ($1,$2,$3) RETURNING id, created_at`,
        [randomUUID(), req.auth!.sub, target.id]
      );
    } catch (err) {
      // The partial unique index is the final word under a concurrent
      // double-submit race that the liveRequestBetween check above can't
      // fully rule out -- same outcome as the pending-in-either-direction
      // case above, just reached via the DB instead of the earlier read.
      if ((err as { code?: string })?.code === "23505") {
        return sendJson(res, 409, { error: "There is already a pending friend request between you and this customer." });
      }
      throw err;
    }

    await notifyCustomer(
      target.id,
      "friend_request",
      "Codsi Saaxiibtinimo",
      `${me?.name?.trim() || "Qof"} wuxuu kuu soo diray codsi saaxiibtinimo.`,
      { screen: "friend_requests", requestId: created!.id }
    );

    sendJson(res, 201, {
      id: created!.id,
      status: "pending",
      createdAt: created!.created_at,
      otherId: target.id,
      otherName: target.name,
      otherFriendCode: target.friend_code,
    });
  }
);

// Every pending request touching me, either direction -- an incoming one
// needs Aqbal/Diid, an outgoing one just shows as "waiting".
friendsRouter.get("/customer/friends/requests", requireAuth("customer"), async (req, res) => {
  const myId = req.auth!.sub;
  const rows = await query(
    `SELECT fr.id, fr.status, fr.created_at,
            CASE WHEN fr.requester_id=$1 THEN 'outgoing' ELSE 'incoming' END AS direction,
            oc.id AS other_id, oc.name AS other_name, oc.friend_code AS other_friend_code
     FROM friend_requests fr
     JOIN customers oc ON oc.id = ${OTHER_PARTY_ID_SQL}
     WHERE (fr.requester_id=$1 OR fr.recipient_id=$1) AND fr.status='pending'
     ORDER BY fr.created_at DESC`,
    [myId]
  );
  sendJson(res, 200, rows);
});

async function respondToRequest(
  requestId: string,
  myId: string,
  role: "recipient" | "requester",
  newStatus: "accepted" | "declined" | "cancelled"
) {
  const column = role === "recipient" ? "recipient_id" : "requester_id";
  return queryOne<{ id: string; requester_id: string; recipient_id: string }>(
    `UPDATE friend_requests SET status=$1, responded_at=now()
     WHERE id=$2 AND ${column}=$3 AND status='pending'
     RETURNING id, requester_id, recipient_id`,
    [newStatus, requestId, myId]
  );
}

friendsRouter.post("/customer/friends/requests/:id/accept", requireAuth("customer"), async (req, res) => {
  const updated = await respondToRequest(req.params.id, req.auth!.sub, "recipient", "accepted");
  if (!updated) return sendJson(res, 404, { error: "Friend request not found" });

  const me = await queryOne<{ name: string | null }>(`SELECT name FROM customers WHERE id=$1`, [req.auth!.sub]);
  await notifyCustomer(
    updated.requester_id,
    "friend_accepted",
    "Codsi La Aqbalay",
    `${me?.name?.trim() || "Qof"} wuxuu aqbalay codsigaaga saaxiibtinimo.`,
    { screen: "friend_chat", friendshipId: updated.id }
  );
  sendJson(res, 200, { id: updated.id, status: "accepted" });
});

friendsRouter.post("/customer/friends/requests/:id/decline", requireAuth("customer"), async (req, res) => {
  const updated = await respondToRequest(req.params.id, req.auth!.sub, "recipient", "declined");
  if (!updated) return sendJson(res, 404, { error: "Friend request not found" });
  sendJson(res, 200, { id: updated.id, status: "declined" });
});

friendsRouter.post("/customer/friends/requests/:id/cancel", requireAuth("customer"), async (req, res) => {
  const updated = await respondToRequest(req.params.id, req.auth!.sub, "requester", "cancelled");
  if (!updated) return sendJson(res, 404, { error: "Friend request not found" });
  sendJson(res, 200, { id: updated.id, status: "cancelled" });
});

// ---------------- Friends list ----------------

friendsRouter.get("/customer/friends", requireAuth("customer"), async (req, res) => {
  const myId = req.auth!.sub;
  const rows = await query(
    `SELECT fr.id, fr.responded_at,
            oc.id AS other_id, oc.name AS other_name, oc.friend_code AS other_friend_code
     FROM friend_requests fr
     JOIN customers oc ON oc.id = ${OTHER_PARTY_ID_SQL}
     WHERE (fr.requester_id=$1 OR fr.recipient_id=$1) AND fr.status='accepted'
     ORDER BY fr.responded_at DESC NULLS LAST`,
    [myId]
  );
  sendJson(res, 200, rows);
});

/** Loads a friend_requests row this customer is actually a party to,
 * regardless of status -- shared by block/messages/report below, each of
 * which then applies its own additional status requirement. */
async function loadOwnFriendship(id: string, myId: string) {
  return queryOne<{ id: string; requester_id: string; recipient_id: string; status: string }>(
    `SELECT id, requester_id, recipient_id, status FROM friend_requests
     WHERE id=$1 AND (requester_id=$2 OR recipient_id=$2)`,
    [id, myId]
  );
}

function otherIdOf(row: { requester_id: string; recipient_id: string }, myId: string): string {
  return row.requester_id === myId ? row.recipient_id : row.requester_id;
}

friendsRouter.post("/customer/friends/:id/block", requireAuth("customer"), async (req, res) => {
  const row = await loadOwnFriendship(req.params.id, req.auth!.sub);
  if (!row) return sendJson(res, 404, { error: "Friend not found" });
  await query(`UPDATE friend_requests SET status='blocked', responded_at=now() WHERE id=$1`, [row.id]);
  sendJson(res, 200, { id: row.id, status: "blocked" });
});

// ---------------- Private 1-to-1 chat (accepted friends only) ----------------

friendsRouter.get("/customer/friends/:id/messages", requireAuth("customer"), async (req, res) => {
  const row = await loadOwnFriendship(req.params.id, req.auth!.sub);
  if (!row || row.status !== "accepted") return sendJson(res, 404, { error: "Friend not found" });
  const messages = await query(
    `SELECT id, sender_id, body, created_at FROM friend_messages
     WHERE friend_request_id=$1 ORDER BY created_at ASC LIMIT 500`,
    [row.id]
  );
  sendJson(res, 200, messages);
});

friendsRouter.post("/customer/friends/:id/messages", requireAuth("customer"), async (req, res) => {
  const row = await loadOwnFriendship(req.params.id, req.auth!.sub);
  if (!row || row.status !== "accepted") return sendJson(res, 404, { error: "Friend not found" });

  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) return sendJson(res, 400, { error: "Message body is required" });
  if (body.length > 2000) return sendJson(res, 400, { error: "Message is too long" });

  const message = await queryOne<{ id: string; created_at: string }>(
    `INSERT INTO friend_messages (id, friend_request_id, sender_id, body) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
    [randomUUID(), row.id, req.auth!.sub, body]
  );

  const me = await queryOne<{ name: string | null }>(`SELECT name FROM customers WHERE id=$1`, [req.auth!.sub]);
  await notifyCustomer(
    otherIdOf(row, req.auth!.sub),
    "friend_message",
    me?.name?.trim() || "Qof",
    body.length > 120 ? `${body.slice(0, 117)}...` : body,
    { screen: "friend_chat", friendshipId: row.id }
  );

  sendJson(res, 201, { id: message!.id, senderId: req.auth!.sub, body, createdAt: message!.created_at });
});

// ---------------- Report ----------------
// Reuses the existing feedback table/admin review queue rather than a new
// moderation system -- an admin already reviews every feedback row from the
// Admin dashboard (see feedback.routes.ts), which is exactly who should see
// this too.
friendsRouter.post("/customer/friends/:id/report", requireAuth("customer"), async (req, res) => {
  const row = await loadOwnFriendship(req.params.id, req.auth!.sub);
  if (!row) return sendJson(res, 404, { error: "Friend not found" });
  const other = await queryOne<{ name: string | null; friend_code: string }>(
    `SELECT name, friend_code FROM customers WHERE id=$1`,
    [otherIdOf(row, req.auth!.sub)]
  );
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const message = `Reported ${other?.name?.trim() || "a customer"} (${other?.friend_code ?? "?"})${reason ? `: ${reason}` : ""}`;
  await query(`INSERT INTO feedback (id, customer_id, category, message) VALUES ($1,$2,$3,$4)`, [
    randomUUID(),
    req.auth!.sub,
    "Friend Report",
    message,
  ]);
  sendJson(res, 200, { ok: true });
});
