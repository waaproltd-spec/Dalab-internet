// Run against a real local Postgres test database:
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test --test-force-exit src/routes/__tests__/walletNameLookup.test.ts
//
// Covers the Wallet Name Lookup flow end to end at the HTTP layer: a
// customer (or anything else that starts one) starting a lookup, an agent
// device claiming and reporting it, and the customer polling for the
// result. This feature stays available as its own infrastructure, but
// PUT /customer/wallet-numbers (the "Complete Account" / eBadal save) does
// NOT require or read a lookup at all — the customer types both the Full
// Name and the Number themselves on wallet_numbers_screen.dart and saves
// them directly, same as the Admin/Agent override routes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { exchangeRouter } from "../exchange.routes.js";
import { customersRouter } from "../customers.routes.js";

const AGENT_ID = randomUUID();
const OTHER_AGENT_ID = randomUUID();
const DEVICE_ID = "test-lookup-device-1";
const CUSTOMER_ID = randomUUID();
const OTHER_CUSTOMER_ID = randomUUID();

const app = express();
app.use(express.json());
app.use(exchangeRouter);
app.use(customersRouter);
let server: http.Server;
let baseUrl: string;
let customerToken: string;
let otherCustomerToken: string;
let agentToken: string;
let otherAgentToken: string;

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
  await query(`DELETE FROM wallet_name_lookups`);
  await query(`DELETE FROM exchange_dial_attempts`);
  await query(`DELETE FROM exchange_orders`);
  await query(`DELETE FROM exchange_corridors`);
  await query(`DELETE FROM exchange_payout_wallets`);
  // Deletes by the fixed literal phone too, not just this run's fresh
  // random id -- a prior run that crashed mid-test can leave a
  // same-phone row behind under a DIFFERENT id, which an id-only delete
  // would never find, tripping the unique constraint on this run's insert.
  await query(`DELETE FROM customers WHERE id IN ($1,$2) OR phone IN ('252677100001','252677100002')`, [CUSTOMER_ID, OTHER_CUSTOMER_ID]);
  await query(`DELETE FROM agents WHERE id IN ($1,$2) OR phone IN ('252699000002','252699000003')`, [AGENT_ID, OTHER_AGENT_ID]);
  await query(`DELETE FROM agent_devices WHERE id=$1`, [DEVICE_ID]);

  await query(`INSERT INTO agent_devices (id, name) VALUES ($1, 'Test Lookup Device')`, [DEVICE_ID]);
  await query(
    `INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000002', 'Test Lookup Agent', 'x', $2)`,
    [AGENT_ID, DEVICE_ID]
  );
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1, '252699000003', 'Other Agent', 'x')`, [OTHER_AGENT_ID]);
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '252677100001')`, [CUSTOMER_ID]);
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '252677100002')`, [OTHER_CUSTOMER_ID]);

  // EVC Plus's own SIM config -- what the claim endpoint resolves simSlot
  // from. No PIN needed: a lookup never authorizes a real transfer.
  await query(
    `INSERT INTO exchange_payout_wallets (wallet_id, device_id, sim_slot, phone_number) VALUES ('evc_plus',$1,1,'252610338686')`,
    [DEVICE_ID]
  );

  customerToken = signAccessToken(CUSTOMER_ID, "customer");
  otherCustomerToken = signAccessToken(OTHER_CUSTOMER_ID, "customer");
  agentToken = signAccessToken(AGENT_ID, "agent");
  otherAgentToken = signAccessToken(OTHER_AGENT_ID, "agent");

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

test("POST /customer/wallet-lookups rejects an unrecognized walletId", async () => {
  const res = await fetch(`${baseUrl}/customer/wallet-lookups`, {
    method: "POST",
    ...authed(customerToken, { walletId: "somlink", phoneNumber: "610338686" }),
  });
  assert.equal(res.status, 400);
});

test("POST /customer/wallet-lookups rejects a number with the wrong carrier prefix for the wallet", async () => {
  // 62-prefix is eDahab, not EVC Plus.
  const res = await fetch(`${baseUrl}/customer/wallet-lookups`, {
    method: "POST",
    ...authed(customerToken, { walletId: "evc_plus", phoneNumber: "620338686" }),
  });
  assert.equal(res.status, 400);
});

test("full lookup lifecycle: customer starts it, agent claims + reports success, customer sees it", async () => {
  const startRes = await fetch(`${baseUrl}/customer/wallet-lookups`, {
    method: "POST",
    ...authed(customerToken, { walletId: "evc_plus", phoneNumber: "610338686" }),
  });
  assert.equal(startRes.status, 201);
  const started = await asJson(startRes);
  assert.equal(started.status, "pending");
  assert.equal(started.phoneNumber, "610338686");

  // Another customer must never be able to read this lookup.
  const stolenRes = await fetch(`${baseUrl}/customer/wallet-lookups/${started.id}`, authed(otherCustomerToken));
  assert.equal(stolenRes.status, 404);

  // Agent claims it.
  const claimRes = await fetch(`${baseUrl}/agent/wallet-lookups/${started.id}/claim`, {
    method: "POST",
    ...authed(agentToken),
  });
  assert.equal(claimRes.status, 200);
  const claim = await asJson(claimRes);
  assert.equal(claim.simSlot, 1);
  assert.equal(claim.lookupUssdString, "*712*610338686*1#", "must dial the exact nominal $1 EVC Plus lookup prompt, receiver = the number being looked up");

  // A second device racing for the same lookup must lose.
  const doubleClaimRes = await fetch(`${baseUrl}/agent/wallet-lookups/${started.id}/claim`, {
    method: "POST",
    ...authed(otherAgentToken),
  });
  assert.equal(doubleClaimRes.status, 409);

  // Reporting SUCCESS with no name is refused outright (fail-safe by construction).
  const badReportRes = await fetch(`${baseUrl}/agent/wallet-lookups/${started.id}`, {
    method: "PUT",
    ...authed(agentToken, { status: "success" }),
  });
  assert.equal(badReportRes.status, 400);

  const reportRes = await fetch(`${baseUrl}/agent/wallet-lookups/${started.id}`, {
    method: "PUT",
    ...authed(agentToken, { status: "success", registeredName: "YASIIN MAXAMED AADAN", rawResponse: "Uwareeji $1 YASIIN MAXAMED AADAN (610338686), Geli PIN-kaaga" }),
  });
  assert.equal(reportRes.status, 200);

  const polledRes = await fetch(`${baseUrl}/customer/wallet-lookups/${started.id}`, authed(customerToken));
  const polled = await asJson(polledRes);
  assert.equal(polled.status, "success");
  assert.equal(polled.registeredName, "YASIIN MAXAMED AADAN");
});

test("PUT /customer/wallet-numbers saves a name the customer typed themselves, with no lookup involved at all", async () => {
  const res = await fetch(`${baseUrl}/customer/wallet-numbers`, {
    method: "PUT",
    ...authed(customerToken, { evcPlusName: "SELF TYPED NAME", evcPlusNumber: "252610338687" }),
  });
  assert.equal(res.status, 200);
  const saved = await asJson(res);
  assert.equal(saved.evcPlusName, "SELF TYPED NAME", "the customer's own typed name must be saved as-is — no Wallet Name Lookup required");
  assert.equal(saved.evcPlusNumber, "252610338687");
});

test("PUT /customer/wallet-numbers ignores a lookupId if one is still sent — it is not read or enforced", async () => {
  const startRes = await fetch(`${baseUrl}/customer/wallet-lookups`, {
    method: "POST",
    ...authed(customerToken, { walletId: "evc_plus", phoneNumber: "610338688" }),
  });
  const started = await asJson(startRes);

  const res = await fetch(`${baseUrl}/customer/wallet-numbers`, {
    method: "PUT",
    ...authed(customerToken, { evcPlusName: "TYPED NAME", evcPlusNumber: "252610338699", lookupId: started.id }),
  });
  assert.equal(res.status, 200);
  const saved = await asJson(res);
  assert.equal(saved.evcPlusName, "TYPED NAME");
  assert.equal(saved.evcPlusNumber, "252610338699", "the saved number need not match the unrelated lookup's own number");
});

test("an abandoned claim (past its 2-minute grace) is put back up for grabs", async () => {
  const startRes = await fetch(`${baseUrl}/customer/wallet-lookups`, {
    method: "POST",
    ...authed(customerToken, { walletId: "evc_plus", phoneNumber: "610338690" }),
  });
  const started = await asJson(startRes);
  const claimRes = await fetch(`${baseUrl}/agent/wallet-lookups/${started.id}/claim`, { method: "POST", ...authed(agentToken) });
  assert.equal(claimRes.status, 200);

  // Simulate the claiming device having gone silent well past the grace window.
  await query(`UPDATE wallet_name_lookups SET created_at = now() - interval '5 minutes' WHERE id=$1`, [started.id]);

  const listRes = await fetch(`${baseUrl}/agent/wallet-lookups`, authed(otherAgentToken));
  const list = await asJson(listRes);
  assert.ok(list.some((row: { id: string }) => row.id === started.id), "an abandoned claim must reappear in the pending queue for another device");

  const reclaimRes = await fetch(`${baseUrl}/agent/wallet-lookups/${started.id}/claim`, { method: "POST", ...authed(otherAgentToken) });
  assert.equal(reclaimRes.status, 200);
});
