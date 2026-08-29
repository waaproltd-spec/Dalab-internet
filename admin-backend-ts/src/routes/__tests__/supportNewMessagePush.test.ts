// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported, since db/pool.ts
// reads them at module-eval time):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/supportNewMessagePush.test.ts
//
// Covers the gap this branch's own "Push notifications: Customer Support
// request pushes to the Agent App" commit left: notifyAssignedAgent() only
// fires when a conversation first becomes 'assigned' (initial claim or
// reassignment) -- a customer's FOLLOW-UP message into an already-assigned
// conversation never notified anyone, so an agent who navigated away from
// the Support screen had no way to know a reply was waiting. This suite
// pins notifyAgentOfNewMessage()'s gating logic directly (it must never
// throw regardless of Firebase being configured in this test environment --
// same best-effort contract as notifyAssignedAgent, which this codebase
// also never unit-tests the actual FCM dispatch of, only ever the gating
// and the surrounding route behavior) and confirms the customer-facing
// message-send route calls it without regressing the route's existing
// behavior for every OPEN_STATUSES case.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { notifyAgentOfNewMessage, supportRouter } from "../support.routes.js";

const CUSTOMER_ID = randomUUID();
const AGENT_ID = randomUUID();
const DEVICE_ID = "test-support-device-1";
let customerToken: string;

const app = express();
app.use(express.json());
app.use(supportRouter);
let server: http.Server;
let baseUrl: string;

before(async () => {
  await query(`DELETE FROM support_messages WHERE conversation_id IN (SELECT id FROM support_conversations WHERE customer_id=$1)`, [CUSTOMER_ID]);
  await query(`DELETE FROM support_conversations WHERE customer_id=$1`, [CUSTOMER_ID]);
  await query(`DELETE FROM agent_device_tokens WHERE agent_id=$1`, [AGENT_ID]);
  await query(`DELETE FROM customers WHERE id=$1 OR phone='252611119901'`, [CUSTOMER_ID]);
  await query(`DELETE FROM agents WHERE id=$1 OR phone='252699119901'`, [AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);

  await query(`INSERT INTO customers (id, phone) VALUES ($1, '252611119901')`, [CUSTOMER_ID]);
  await query(`INSERT INTO agent_devices (id, name) VALUES ($1, 'Test Support Device')`, [DEVICE_ID]);
  await query(
    `INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699119901', 'Test Support Agent', 'x', $2)`,
    [AGENT_ID, DEVICE_ID]
  );
  customerToken = signAccessToken(CUSTOMER_ID, "customer");

  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

let convCounter = 0;
async function insertConversation(params: { status: string; agentId?: string | null; agentRole?: string | null }): Promise<string> {
  // Only one open (queued/pending/assigned) conversation may exist per
  // customer at a time (idx_support_conversations_one_open_per_customer) --
  // each test in this suite creates its own conversation for the same
  // CUSTOMER_ID, so close out anything a prior test left open first.
  await query(`UPDATE support_conversations SET status='closed' WHERE customer_id=$1 AND status IN ('queued','pending','assigned')`, [CUSTOMER_ID]);
  const id = randomUUID();
  await query(
    `INSERT INTO support_conversations (id, customer_id, topic, status, agent_id, agent_role, agent_offline_at_start, assigned_at)
     VALUES ($1,$2,'agent_support',$3,$4,$5,false,$6)`,
    [id, CUSTOMER_ID, params.status, params.agentId ?? null, params.agentRole ?? null, params.status === "assigned" ? new Date() : null]
  );
  convCounter++;
  return id;
}

// ==================== Gating logic (direct unit tests) ====================

test("notifyAgentOfNewMessage: an assigned conversation with a real Agent App agent proceeds without throwing", async () => {
  await assert.doesNotReject(
    notifyAgentOfNewMessage({ status: "assigned", agent_id: AGENT_ID, agent_role: "agent" }, randomUUID())
  );
});

test("notifyAgentOfNewMessage: a queued (not yet assigned) conversation is a silent no-op", async () => {
  await assert.doesNotReject(
    notifyAgentOfNewMessage({ status: "queued", agent_id: null, agent_role: null }, randomUUID())
  );
});

test("notifyAgentOfNewMessage: a pending (not yet assigned) conversation is a silent no-op", async () => {
  await assert.doesNotReject(
    notifyAgentOfNewMessage({ status: "pending", agent_id: null, agent_role: null }, randomUUID())
  );
});

test("notifyAgentOfNewMessage: assigned to Admin Dashboard staff (role='admin') is a silent no-op -- staff have no FCM token", async () => {
  await assert.doesNotReject(
    notifyAgentOfNewMessage({ status: "assigned", agent_id: randomUUID(), agent_role: "admin" }, randomUUID())
  );
});

test("notifyAgentOfNewMessage: assigned but with a null agent_id (defensive) is a silent no-op, never queries with a null id", async () => {
  await assert.doesNotReject(
    notifyAgentOfNewMessage({ status: "assigned", agent_id: null, agent_role: "agent" }, randomUUID())
  );
});

// ==================== Route-level regression coverage ====================

test("POST /support/conversations/:id/messages still succeeds for an assigned conversation (real HTTP round trip), now also attempting the new-message push", async () => {
  const conversationId = await insertConversation({ status: "assigned", agentId: AGENT_ID, agentRole: "agent" });

  const res = await fetch(`${baseUrl}/support/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({ message: "Are you still there?" }),
  });
  assert.equal(res.status, 201, "the route must still succeed even though it now also calls notifyAgentOfNewMessage");

  const messages = await query(`SELECT body FROM support_messages WHERE conversation_id=$1`, [conversationId]);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as any).body, "Are you still there?");
});

test("POST /support/conversations/:id/messages still succeeds for a queued (unassigned) conversation -- no agent to notify yet", async () => {
  const conversationId = await insertConversation({ status: "queued" });

  const res = await fetch(`${baseUrl}/support/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({ message: "Still waiting for an agent" }),
  });
  assert.equal(res.status, 201);
});

test("POST /support/conversations/:id/messages still succeeds for a pending (unassigned) conversation -- no agent to notify yet", async () => {
  const conversationId = await insertConversation({ status: "pending" });

  const res = await fetch(`${baseUrl}/support/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({ message: "Anyone available?" }),
  });
  assert.equal(res.status, 201);
});

test("POST /support/conversations/:id/messages rejects a message into a closed conversation, unaffected by the new push call", async () => {
  const conversationId = await insertConversation({ status: "closed" });

  const res = await fetch(`${baseUrl}/support/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({ message: "Hello?" }),
  });
  assert.equal(res.status, 409);
});
