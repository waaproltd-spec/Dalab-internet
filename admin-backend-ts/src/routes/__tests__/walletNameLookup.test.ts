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
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { exchangeRouter } from "../exchange.routes.js";
import { customersRouter } from "../customers.routes.js";

const AGENT_ID = randomUUID();
const OTHER_AGENT_ID = randomUUID();
const DEVICE_ID = "test-lookup-device-1";
const CUSTOMER_ID = randomUUID();
const OTHER_CUSTOMER_ID = randomUUID();
const THIRD_CUSTOMER_ID = randomUUID();

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
let superAdminToken: string;

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
  await query(`DELETE FROM customers WHERE id IN ($1,$2,$3) OR phone IN ('252677100001','252677100002','252677100003')`, [
    CUSTOMER_ID,
    OTHER_CUSTOMER_ID,
    THIRD_CUSTOMER_ID,
  ]);
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
  await query(`INSERT INTO customers (id, phone) VALUES ($1, '252677100003')`, [THIRD_CUSTOMER_ID]);

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
  superAdminToken = signAccessToken(randomUUID(), "super_admin");

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

// ==================== eBadal duplicate-number guard ====================
// A phone number must only ever be registered/activated once in eBadal,
// enforced server-side across all three routes that can set it (customer
// self-service, Agent override, Admin override) — not just the customer
// app's own UI, so the same number can never slip through a different
// endpoint.
const EBADAL_DUPLICATE_MESSAGE =
  "Number-kan hore ayuu uga diiwaangashan yahay Ebadal, mana suuragal ahan in account cusub lagu sameeyo ama mar kale la kiciyo. Fadlan isticmaal number kale.";

test("PUT /customer/wallet-numbers rejects a number already registered by another customer", async () => {
  const firstSave = await fetch(`${baseUrl}/customer/wallet-numbers`, {
    method: "PUT",
    ...authed(otherCustomerToken, { edahabName: "FIRST OWNER", edahabNumber: "620346060" }),
  });
  assert.equal(firstSave.status, 200);

  const dupRes = await fetch(`${baseUrl}/customer/wallet-numbers`, {
    method: "PUT",
    ...authed(customerToken, { edahabName: "SECOND ATTEMPT", edahabNumber: "620346060" }),
  });
  assert.equal(dupRes.status, 409);
  const dupBody = await asJson(dupRes);
  assert.equal(dupBody.error, EBADAL_DUPLICATE_MESSAGE);

  const check = await fetch(`${baseUrl}/customer/wallet-numbers`, { method: "PUT", ...authed(customerToken, {}) });
  const checkBody = await asJson(check);
  assert.notEqual(checkBody.edahabNumber, "620346060", "the rejected duplicate must never have been saved");
});

test("PUT /customer/wallet-numbers allows re-saving the customer's own already-registered number (not a false-positive duplicate)", async () => {
  const res = await fetch(`${baseUrl}/customer/wallet-numbers`, {
    method: "PUT",
    ...authed(otherCustomerToken, { edahabName: "FIRST OWNER RENAMED", edahabNumber: "620346060" }),
  });
  assert.equal(res.status, 200, "resubmitting your own already-registered number must succeed, not be flagged as a duplicate");
  const body = await asJson(res);
  assert.equal(body.edahabName, "FIRST OWNER RENAMED");
});

test("PUT /agent/customers/:id/wallet-numbers also rejects a duplicate number (enforced server-side, not just the customer app's UI)", async () => {
  // 620346060 is already OTHER_CUSTOMER_ID's eDahab number from the test above.
  const res = await fetch(`${baseUrl}/agent/customers/${CUSTOMER_ID}/wallet-numbers`, {
    method: "PUT",
    ...authed(agentToken, { edahabName: "AGENT TRIED", edahabNumber: "620346060" }),
  });
  assert.equal(res.status, 409);
  const body = await asJson(res);
  assert.equal(body.error, EBADAL_DUPLICATE_MESSAGE);
});

test("PUT /admin/customers/:id/wallet-numbers also rejects a duplicate number (enforced server-side, not just the customer app's UI)", async () => {
  const res = await fetch(`${baseUrl}/admin/customers/${CUSTOMER_ID}/wallet-numbers`, {
    method: "PUT",
    ...authed(superAdminToken, { edahabName: "ADMIN TRIED", edahabNumber: "620346060" }),
  });
  assert.equal(res.status, 409);
  const body = await asJson(res);
  assert.equal(body.error, EBADAL_DUPLICATE_MESSAGE);
});

// The exact "one wallet number = one account" rule: 619991299 (EVC Plus)
// registered once must reject every other route's attempt to link it to a
// second, different account -- Customer self-service, Agent override, and
// Admin override all cannot bypass it -- while the original owner's own
// re-save of their own number keeps working with no false positive.
test("619991299 already registered to one account cannot be linked to a second account via Customer, Agent, or Admin routes", async () => {
  const firstReg = await fetch(`${baseUrl}/customer/wallet-numbers`, {
    method: "PUT",
    ...authed(customerToken, { evcPlusName: "FIRST ACCOUNT", evcPlusNumber: "619991299" }),
  });
  assert.equal(firstReg.status, 200, "first registration must be allowed");

  // Customer self-service: a second, different account trying to register it.
  const customerAttempt = await fetch(`${baseUrl}/customer/wallet-numbers`, {
    method: "PUT",
    ...authed(otherCustomerToken, { evcPlusName: "SECOND ACCOUNT (customer)", evcPlusNumber: "619991299" }),
  });
  assert.equal(customerAttempt.status, 409);
  assert.equal((await asJson(customerAttempt)).error, EBADAL_DUPLICATE_MESSAGE);

  // Agent override cannot bypass the rule.
  const agentAttempt = await fetch(`${baseUrl}/agent/customers/${OTHER_CUSTOMER_ID}/wallet-numbers`, {
    method: "PUT",
    ...authed(agentToken, { evcPlusName: "SECOND ACCOUNT (agent)", evcPlusNumber: "619991299" }),
  });
  assert.equal(agentAttempt.status, 409);
  assert.equal((await asJson(agentAttempt)).error, EBADAL_DUPLICATE_MESSAGE);

  // Admin override cannot bypass the rule either -- a third, distinct
  // account, proving this isn't limited to just the two accounts above.
  const adminAttempt = await fetch(`${baseUrl}/admin/customers/${THIRD_CUSTOMER_ID}/wallet-numbers`, {
    method: "PUT",
    ...authed(superAdminToken, { evcPlusName: "THIRD ACCOUNT (admin)", evcPlusNumber: "619991299" }),
  });
  assert.equal(adminAttempt.status, 409);
  assert.equal((await asJson(adminAttempt)).error, EBADAL_DUPLICATE_MESSAGE);

  // None of the rejected attempts may have been saved -- the number must
  // still belong to exactly the first (and only) account.
  const otherState = await queryOne<{ evc_plus_number: string | null }>(`SELECT evc_plus_number FROM customers WHERE id=$1`, [OTHER_CUSTOMER_ID]);
  const thirdState = await queryOne<{ evc_plus_number: string | null }>(`SELECT evc_plus_number FROM customers WHERE id=$1`, [THIRD_CUSTOMER_ID]);
  assert.notEqual(otherState?.evc_plus_number, "619991299");
  assert.notEqual(thirdState?.evc_plus_number, "619991299");

  // The original owner's own re-save/update of their own number must still
  // succeed -- not a false positive.
  const ownResave = await fetch(`${baseUrl}/customer/wallet-numbers`, {
    method: "PUT",
    ...authed(customerToken, { evcPlusName: "FIRST ACCOUNT RENAMED", evcPlusNumber: "619991299" }),
  });
  assert.equal(ownResave.status, 200, "the original account must still be able to re-save/update its own number");
});

// Strict "one number = one account" rule: a registration submitting BOTH an
// EVC Plus and an eDahab number in the same call must be rejected in full
// the moment EITHER one is already taken -- even when the other number is
// perfectly new and would otherwise be allowed on its own. Neither field
// may be partially saved.
test("registering EVC Plus (already taken) + eDahab (brand new) together rejects the entire request -- the new number is not partially saved", async () => {
  // OTHER_CUSTOMER_ID already owns edahabNumber 620346060 from earlier
  // tests -- capture it so we can prove it's still unchanged afterward.
  const before = await queryOne<{ evc_plus_number: string | null; edahab_number: string | null }>(
    `SELECT evc_plus_number, edahab_number FROM customers WHERE id=$1`,
    [OTHER_CUSTOMER_ID]
  );

  // 619991299 is CUSTOMER_ID's real EVC Plus number (registered above).
  // 622209876 has never been used anywhere in this suite.
  const res = await fetch(`${baseUrl}/customer/wallet-numbers`, {
    method: "PUT",
    ...authed(otherCustomerToken, {
      evcPlusName: "MIXED ATTEMPT EVC",
      evcPlusNumber: "619991299",
      edahabName: "MIXED ATTEMPT EDAHAB",
      edahabNumber: "622209876",
    }),
  });
  assert.equal(res.status, 409);
  assert.equal((await asJson(res)).error, EBADAL_DUPLICATE_MESSAGE);

  const after = await queryOne<{ evc_plus_number: string | null; edahab_number: string | null }>(
    `SELECT evc_plus_number, edahab_number FROM customers WHERE id=$1`,
    [OTHER_CUSTOMER_ID]
  );
  assert.equal(after?.evc_plus_number, before?.evc_plus_number, "the duplicate EVC Plus number must not have been saved");
  assert.equal(
    after?.edahab_number,
    before?.edahab_number,
    "the brand-new eDahab number submitted in the SAME request must also be rejected -- the whole registration fails atomically, not just the duplicate field"
  );
  assert.notEqual(after?.edahab_number, "622209876");

  // 622209876 must remain completely free -- confirmed by successfully
  // registering it on its own, on a clean account with no duplicate field
  // alongside it.
  const cleanReg = await fetch(`${baseUrl}/admin/customers/${THIRD_CUSTOMER_ID}/wallet-numbers`, {
    method: "PUT",
    ...authed(superAdminToken, { edahabName: "LEGITIMATE NEW OWNER", edahabNumber: "622209876" }),
  });
  assert.equal(cleanReg.status, 200, "622209876 itself was never actually taken -- only the mixed request containing the duplicate EVC Plus number must fail");
});
