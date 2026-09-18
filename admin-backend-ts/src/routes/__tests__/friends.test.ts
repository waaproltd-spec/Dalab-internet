// Run against a real local Postgres test database:
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test --test-force-exit src/routes/__tests__/friends.test.ts
//
// Covers the private Friend system end to end at the HTTP layer: search is
// exact-match-only (no directory), a request must be accepted before chat
// unlocks, and block/decline/cancel all correctly close off further
// requests or re-open them where the product spec says they should.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { friendsRouter } from "../friends.routes.js";

const CUSTOMER_A_ID = randomUUID();
const CUSTOMER_B_ID = randomUUID();
const CUSTOMER_C_ID = randomUUID();

const app = express();
app.use(express.json());
app.use(friendsRouter);
let server: http.Server;
let baseUrl: string;
let tokenA: string;
let tokenB: string;
let tokenC: string;
let codeA: string;
let codeB: string;
let codeC: string;

async function asJson(res: Response): Promise<any> {
  return res.json();
}

function authed(token: string, body?: unknown) {
  return {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

before(async () => {
  await query(`DELETE FROM friend_messages WHERE friend_request_id IN (SELECT id FROM friend_requests WHERE requester_id IN ($1,$2,$3) OR recipient_id IN ($1,$2,$3))`, [
    CUSTOMER_A_ID,
    CUSTOMER_B_ID,
    CUSTOMER_C_ID,
  ]);
  await query(`DELETE FROM friend_requests WHERE requester_id IN ($1,$2,$3) OR recipient_id IN ($1,$2,$3)`, [
    CUSTOMER_A_ID,
    CUSTOMER_B_ID,
    CUSTOMER_C_ID,
  ]);
  await query(`DELETE FROM notifications WHERE customer_id IN ($1,$2,$3)`, [CUSTOMER_A_ID, CUSTOMER_B_ID, CUSTOMER_C_ID]);
  await query(`DELETE FROM feedback WHERE customer_id IN ($1,$2,$3)`, [CUSTOMER_A_ID, CUSTOMER_B_ID, CUSTOMER_C_ID]);
  await query(`DELETE FROM customers WHERE id IN ($1,$2,$3) OR phone IN ('252677200001','252677200002','252677200003')`, [
    CUSTOMER_A_ID,
    CUSTOMER_B_ID,
    CUSTOMER_C_ID,
  ]);

  await query(`INSERT INTO customers (id, phone, name) VALUES ($1, '252677200001', 'Customer A')`, [CUSTOMER_A_ID]);
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1, '252677200002', 'Customer B')`, [CUSTOMER_B_ID]);
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1, '252677200003', 'Customer C')`, [CUSTOMER_C_ID]);

  const a = await queryOne<{ friend_code: string }>(`SELECT friend_code FROM customers WHERE id=$1`, [CUSTOMER_A_ID]);
  const b = await queryOne<{ friend_code: string }>(`SELECT friend_code FROM customers WHERE id=$1`, [CUSTOMER_B_ID]);
  const c = await queryOne<{ friend_code: string }>(`SELECT friend_code FROM customers WHERE id=$1`, [CUSTOMER_C_ID]);
  codeA = a!.friend_code;
  codeB = b!.friend_code;
  codeC = c!.friend_code;

  tokenA = signAccessToken(CUSTOMER_A_ID, "customer");
  tokenB = signAccessToken(CUSTOMER_B_ID, "customer");
  tokenC = signAccessToken(CUSTOMER_C_ID, "customer");

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

test("every customer gets a unique, permanent DALAB-XXXX friend code", async () => {
  assert.match(codeA, /^DALAB-[A-Z0-9]{4}$/);
  assert.match(codeB, /^DALAB-[A-Z0-9]{4}$/);
  assert.notEqual(codeA, codeB);
});

test("search finds only the exact code match -- never a directory, never a partial/name match", async () => {
  const res = await fetch(`${baseUrl}/customer/friends/search?code=${encodeURIComponent(codeB)}`, authed(tokenA));
  assert.equal(res.status, 200);
  const body = await asJson(res);
  assert.equal(body.id, CUSTOMER_B_ID);
  assert.equal(body.friendCode, codeB);
  assert.equal(body.relationshipStatus, "none");

  const notFound = await fetch(`${baseUrl}/customer/friends/search?code=DALAB-0000`, authed(tokenA));
  assert.equal(notFound.status, 404);

  const byName = await fetch(`${baseUrl}/customer/friends/search?code=${encodeURIComponent("Customer B")}`, authed(tokenA));
  assert.equal(byName.status, 400, "a name is never a valid search input -- only an exact Friend ID");
});

test("searching your own code is rejected rather than returning yourself", async () => {
  const res = await fetch(`${baseUrl}/customer/friends/search?code=${encodeURIComponent(codeA)}`, authed(tokenA));
  assert.equal(res.status, 400);
});

test("full flow: request -> notification -> accept -> friends -> chat unlocked", async () => {
  const sendRes = await fetch(`${baseUrl}/customer/friends/requests`, {
    method: "POST",
    ...authed(tokenA, { friendCode: codeB }),
  });
  assert.equal(sendRes.status, 201);
  const created = await asJson(sendRes);
  assert.equal(created.status, "pending");
  const requestId = created.id;

  // The recipient must have received an in-app notification with the
  // exact required Somali wording, name substituted in.
  const notif = await queryOne<{ title: string; body: string }>(
    `SELECT title, body FROM notifications WHERE customer_id=$1 AND type='friend_request' ORDER BY sent_at DESC LIMIT 1`,
    [CUSTOMER_B_ID]
  );
  assert.ok(notif);
  assert.equal(notif!.body, "Customer A wuxuu kuu soo diray codsi saaxiibtinimo.");

  // A duplicate send in the same direction is rejected.
  const dup = await fetch(`${baseUrl}/customer/friends/requests`, {
    method: "POST",
    ...authed(tokenA, { friendCode: codeB }),
  });
  assert.equal(dup.status, 409);

  // The reverse direction is blocked too -- B must respond to the existing
  // request rather than create a second, independent one.
  const reverse = await fetch(`${baseUrl}/customer/friends/requests`, {
    method: "POST",
    ...authed(tokenB, { friendCode: codeA }),
  });
  assert.equal(reverse.status, 409);

  // A stranger (the requester) cannot accept their own outgoing request.
  const wrongAccept = await fetch(`${baseUrl}/customer/friends/requests/${requestId}/accept`, {
    method: "POST",
    ...authed(tokenA),
  });
  assert.equal(wrongAccept.status, 404);

  // Only the recipient can accept it.
  const acceptRes = await fetch(`${baseUrl}/customer/friends/requests/${requestId}/accept`, {
    method: "POST",
    ...authed(tokenB),
  });
  assert.equal(acceptRes.status, 200);
  assert.equal((await asJson(acceptRes)).status, "accepted");

  const acceptedNotif = await queryOne<{ body: string }>(
    `SELECT body FROM notifications WHERE customer_id=$1 AND type='friend_accepted' ORDER BY sent_at DESC LIMIT 1`,
    [CUSTOMER_A_ID]
  );
  assert.ok(acceptedNotif);

  // Both sides now see each other in their friends list.
  const friendsOfA = await asJson(await fetch(`${baseUrl}/customer/friends`, authed(tokenA)));
  assert.ok(friendsOfA.some((f: any) => f.otherId === CUSTOMER_B_ID));
  const friendsOfB = await asJson(await fetch(`${baseUrl}/customer/friends`, authed(tokenB)));
  assert.ok(friendsOfB.some((f: any) => f.otherId === CUSTOMER_A_ID));

  // Chat is now unlocked for both participants, in both directions.
  const sendMsg = await fetch(`${baseUrl}/customer/friends/${requestId}/messages`, {
    method: "POST",
    ...authed(tokenA, { body: "Salaan!" }),
  });
  assert.equal(sendMsg.status, 201);

  const msgNotif = await queryOne<{ body: string }>(
    `SELECT body FROM notifications WHERE customer_id=$1 AND type='friend_message' ORDER BY sent_at DESC LIMIT 1`,
    [CUSTOMER_B_ID]
  );
  assert.equal(msgNotif?.body, "Salaan!");

  const replyRes = await fetch(`${baseUrl}/customer/friends/${requestId}/messages`, {
    method: "POST",
    ...authed(tokenB, { body: "Waalaalayn!" }),
  });
  assert.equal(replyRes.status, 201);

  const messages = await asJson(await fetch(`${baseUrl}/customer/friends/${requestId}/messages`, authed(tokenA)));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].body, "Salaan!");
  assert.equal(messages[1].body, "Waalaalayn!");

  // A third party who is not a participant in this friendship cannot read
  // the private chat.
  const intruder = await fetch(`${baseUrl}/customer/friends/${requestId}/messages`, authed(tokenC));
  assert.equal(intruder.status, 404);
});

test("declining a request lets a fresh request be sent afterward", async () => {
  const sendRes = await fetch(`${baseUrl}/customer/friends/requests`, {
    method: "POST",
    ...authed(tokenA, { friendCode: codeC }),
  });
  const requestId = (await asJson(sendRes)).id;

  const decline = await fetch(`${baseUrl}/customer/friends/requests/${requestId}/decline`, {
    method: "POST",
    ...authed(tokenC),
  });
  assert.equal(decline.status, 200);
  assert.equal((await asJson(decline)).status, "declined");

  // Chat must never unlock for a declined request.
  const messagesAttempt = await fetch(`${baseUrl}/customer/friends/${requestId}/messages`, authed(tokenA));
  assert.equal(messagesAttempt.status, 404);

  const retry = await fetch(`${baseUrl}/customer/friends/requests`, {
    method: "POST",
    ...authed(tokenA, { friendCode: codeC }),
  });
  assert.equal(retry.status, 201, "a decline is not permanent -- a new request must be allowed afterward");

  // Leave no pending A<->C request behind -- the next test exercises
  // cancel on a fresh request between this same pair, which the
  // pending-pair unique index would otherwise block.
  const retryId = (await asJson(retry)).id;
  await fetch(`${baseUrl}/customer/friends/requests/${retryId}/cancel`, { method: "POST", ...authed(tokenA) });
});

test("cancelling your own outgoing request works; the recipient cannot cancel it", async () => {
  const sendRes = await fetch(`${baseUrl}/customer/friends/requests`, {
    method: "POST",
    ...authed(tokenC, { friendCode: codeA }),
  });
  const requestId = (await asJson(sendRes)).id;

  const wrongCancel = await fetch(`${baseUrl}/customer/friends/requests/${requestId}/cancel`, {
    method: "POST",
    ...authed(tokenA),
  });
  assert.equal(wrongCancel.status, 404);

  const cancel = await fetch(`${baseUrl}/customer/friends/requests/${requestId}/cancel`, {
    method: "POST",
    ...authed(tokenC),
  });
  assert.equal(cancel.status, 200);
});

test("blocking ends the friendship and permanently forecloses new requests between the pair", async () => {
  // A and B are already friends from the earlier full-flow test.
  const friendsOfA = await asJson(await fetch(`${baseUrl}/customer/friends`, authed(tokenA)));
  const friendship = friendsOfA.find((f: any) => f.otherId === CUSTOMER_B_ID);
  assert.ok(friendship, "precondition: A and B must already be friends here");

  const block = await fetch(`${baseUrl}/customer/friends/${friendship.id}/block`, {
    method: "POST",
    ...authed(tokenA),
  });
  assert.equal(block.status, 200);

  const friendsOfAAfter = await asJson(await fetch(`${baseUrl}/customer/friends`, authed(tokenA)));
  assert.ok(!friendsOfAAfter.some((f: any) => f.otherId === CUSTOMER_B_ID), "a blocked friendship must not appear in the friends list");

  // Chat is cut off immediately.
  const messagesAfterBlock = await fetch(`${baseUrl}/customer/friends/${friendship.id}/messages`, authed(tokenB));
  assert.equal(messagesAfterBlock.status, 404);

  // Neither side can start a new request with the other afterward.
  const retryFromBlocker = await fetch(`${baseUrl}/customer/friends/requests`, {
    method: "POST",
    ...authed(tokenA, { friendCode: codeB }),
  });
  assert.equal(retryFromBlocker.status, 409);
  const retryFromBlocked = await fetch(`${baseUrl}/customer/friends/requests`, {
    method: "POST",
    ...authed(tokenB, { friendCode: codeA }),
  });
  assert.equal(retryFromBlocked.status, 409);
});

test("report writes a reviewable feedback row tagged with the reported customer", async () => {
  const sendRes = await fetch(`${baseUrl}/customer/friends/requests`, {
    method: "POST",
    ...authed(tokenB, { friendCode: codeC }),
  });
  const requestId = (await asJson(sendRes)).id;
  await fetch(`${baseUrl}/customer/friends/requests/${requestId}/accept`, { method: "POST", ...authed(tokenC) });

  const report = await fetch(`${baseUrl}/customer/friends/${requestId}/report`, {
    method: "POST",
    ...authed(tokenB, { reason: "Spam messages" }),
  });
  assert.equal(report.status, 200);

  const row = await queryOne<{ message: string; category: string }>(
    `SELECT message, category FROM feedback WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [CUSTOMER_B_ID]
  );
  assert.equal(row?.category, "Friend Report");
  assert.match(row!.message, /Customer C/);
  assert.match(row!.message, /Spam messages/);
});
