// Run against a real local Postgres test database (DATABASE_URL/PGSSL must
// be set on the process BEFORE this file is imported):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/smsFormats.test.ts
//
// SMS Format Update end to end: a Super Admin pastes a provider's new SMS,
// tests it, saves & activates it; formats are versioned and restorable; one
// provider's format never reads another provider's SMS or an outgoing
// transfer; SMS read by a format still only become a payment through the
// normal matching/verification (an order is NOT paid by reading alone); and
// the same transaction reference is never processed twice.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { smsFormatsRouter } from "../smsFormats.routes.js";
import { ingestPaymentSms } from "../smsLogs.routes.js";
import {
  applyRule,
  defaultChoice,
  detectCandidates,
  findConflicts,
  generateRule,
  providerByKey,
  suggestKeywords,
  validatePattern,
  clearSmsFormatCache,
} from "../../utils/smsFormats.js";

const NEW_EDAHAB =
  "0.09 Dollar Ayaad ka Heshay Yaasiin Maxamed Aadan  (620346060). Tix: PP261009.1511.117314. HHaraagaagu waa: 0.77 Dollar. " +
  "Tar: 09-10-2026 15:11 PM [eDahab Service-Dollar] La soo dag App-ka DahabPlus https://onelink.to/dahabpluss";
const OLD_EDAHAB =
  "0.22 Dollar Ayaad Ka Heshay Yaasiin Maxamed Aadan.Code-ka:NA.Lambarka :620346060  Aqanoosiga : PP260718.0005.F75709 " +
  "Haraagaaga Cusubi Waa: 2.61 Dollar..Tariikh:18-07-2026[-eDahab-Service-]";
const HORMUUD = "[-EVCPLUS-] waxaad $0.1 ka heshay 0610346060, Tar: 24/07/26";
const SOMNET =
  "[-EVCPlus-] $0.1 ayaad ka Heshay AARAN DATA SERVICE (252685115555),27/07/26 04:49:01 via Somnet Telecom, Haraagaagu waa $4.95.";

const SUPER_ADMIN = randomUUID();
const ADMIN = randomUUID();
const AGENT_ID = randomUUID();
const CUSTOMER_ID = randomUUID();
const COMPANY = "test-fmt-somtel";
const CATEGORY_ID = randomUUID();
const PACKAGE_ID = randomUUID();
let superToken: string;
let adminToken: string;
let agentToken: string;

const app = express();
app.use(express.json() as any);
app.use(smsFormatsRouter);
let server: http.Server;
let baseUrl: string;

function call(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  await query(`DELETE FROM sms_format_rule_events`);
  await query(`DELETE FROM sms_format_rules`);
  await query(`DELETE FROM sms_logs`);
  await query(`DELETE FROM payment_transactions`);
  await query(`DELETE FROM orders WHERE id LIKE 'FMTTEST%'`);
  await query(`DELETE FROM admin_users WHERE id IN ($1,$2)`, [SUPER_ADMIN, ADMIN]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'fmt-super@test.local','x','super_admin')`, [SUPER_ADMIN]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'fmt-admin@test.local','x','admin')`, [ADMIN]);
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'252699000177','Fmt Agent','x')`, [AGENT_ID]);
  await query(`INSERT INTO customers (id, phone) VALUES ($1,'252611111177')`, [CUSTOMER_ID]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Fmt Somtel',1,'#000000') ON CONFLICT DO NOTHING`, [COMPANY]);
  await query(`INSERT INTO service_categories (id, company_id, slug, name) VALUES ($1,$2,'data','Data')`, [CATEGORY_ID, COMPANY]);
  await query(`INSERT INTO packages (id, company_id, category_id, name, price, mb) VALUES ($1,$2,$3,'1GB',0.09,1024)`, [PACKAGE_ID, COMPANY, CATEGORY_ID]);
  clearSmsFormatCache();

  superToken = signAccessToken(SUPER_ADMIN, "super_admin");
  adminToken = signAccessToken(ADMIN, "admin");
  agentToken = signAccessToken(AGENT_ID, "agent");
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

function learn(providerKey: string, sms: string) {
  const provider = providerByKey(providerKey)!;
  const c = detectCandidates(sms);
  const choice = defaultChoice(c);
  const { rule, error } = generateRule(sms, c, choice);
  assert.equal(error, undefined);
  return { ...rule, keywords: suggestKeywords(sms, c.amounts[choice.amountIndex]), senders: provider.defaultSenders };
}

// ---------------- The format engine ----------------

test("learns each real provider SMS and reads the payment amount (not the balance), payer number and reference", () => {
  const cases: [string, string, number, string, string | null][] = [
    ["edahab", NEW_EDAHAB, 0.09, "620346060", "PP261009.1511.117314"],
    ["edahab", OLD_EDAHAB, 0.22, "620346060", "PP260718.0005.F75709"],
    ["evc_plus", HORMUUD, 0.1, "0610346060", null],
    ["somnet", SOMNET, 0.1, "252685115555", null],
  ];
  for (const [provider, sms, amount, phone, ref] of cases) {
    const rule = learn(provider, sms);
    const read = applyRule(rule, sms);
    assert.ok(read.ok, `${provider}: ${!read.ok && read.reason}`);
    if (read.ok) {
      assert.equal(read.extracted.amount, amount);
      assert.equal(read.extracted.senderPhone, phone);
      assert.equal(read.extracted.reference, ref);
    }
  }
});

test("a learned format keeps reading later SMS of the same wording with different values", () => {
  const rule = learn("edahab", NEW_EDAHAB);
  const later = NEW_EDAHAB.replace("0.09", "1,250.5").replace("620346060", "615551234").replace("PP261009.1511.117314", "PP261010.0900.E00001");
  const read = applyRule(rule, later);
  assert.ok(read.ok);
  if (read.ok) {
    assert.equal(read.extracted.amount, 1250.5);
    assert.equal(read.extracted.senderPhone, "615551234");
    assert.equal(read.extracted.reference, "PP261010.0900.E00001");
  }
});

test("a format never reads another provider's payment or an outgoing transfer", () => {
  const edahab = learn("edahab", NEW_EDAHAB);
  assert.deepEqual(findConflicts(providerByKey("edahab")!, edahab, NEW_EDAHAB, []), []);
  assert.equal(applyRule(edahab, OLD_EDAHAB.replace("Ayaad Ka Heshay", "ayad u warejisay")).ok, false, "money sent is not money received");

  // A too-loose EVC Plus format (keywords both providers share) is caught.
  const loose = { ...learn("evc_plus", HORMUUD), keywords: ["ka heshay", "EVCPLUS"] };
  const conflicts = findConflicts(providerByKey("evc_plus")!, loose, HORMUUD, []);
  assert.ok(conflicts.some((c) => /Somnet/.test(c)), conflicts.join(" | "));
});

test("patterns that could freeze a phone or read differently on Android are refused", () => {
  assert.match(validatePattern("(a+)+$")!, /Nested repetition/);
  assert.match(validatePattern("(?<=x)\\d+")!, /Look-behind/);
  assert.match(validatePattern("(\\d+)\\1")!, /Back-references/);
  assert.match(validatePattern("\\p{L}+")!, /not allowed/);
  assert.match(validatePattern("([")!, /not valid/);
  assert.equal(validatePattern("\\$\\s*([\\d,]+(?:\\.\\d+)?)"), null);
});

// ---------------- Routes ----------------

test("only a Super Admin can test or activate formats; agents only read active ones", async () => {
  assert.equal((await call("POST", "/admin/sms-formats/test", adminToken, { provider: "edahab", sms: NEW_EDAHAB })).status, 403);
  assert.equal((await call("POST", "/admin/sms-formats", adminToken, { provider: "edahab", sms: NEW_EDAHAB })).status, 403);
  assert.equal((await call("POST", "/admin/sms-formats/test", agentToken, { provider: "edahab", sms: NEW_EDAHAB })).status, 403);
  assert.equal((await call("GET", "/agent/sms-formats", adminToken)).status, 403);
  assert.equal((await call("GET", "/admin/sms-formats", adminToken)).status, 200);
});

test("Test SMS shows what was read; an unreadable SMS gives a clear error and nothing is saved", async () => {
  const ok = await (await call("POST", "/admin/sms-formats/test", superToken, { provider: "edahab", sms: NEW_EDAHAB })).json() as any;
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.extracted, { amount: 0.09, senderPhone: "620346060", reference: "PP261009.1511.117314", recipientPhone: null });
  assert.deepEqual(ok.candidates.amounts, ["0.09", "0.77"]);
  assert.ok(ok.warnings.some((w: string) => /2 amounts/.test(w)));

  const bad = await (await call("POST", "/admin/sms-formats/test", superToken, { provider: "edahab", sms: "Mahadsanid, Ramadan Kariim!" })).json() as any;
  assert.equal(bad.ok, false);
  assert.match(bad.error, /No amount/);

  const missingProvider = await call("POST", "/admin/sms-formats/test", superToken, { sms: NEW_EDAHAB });
  assert.equal(missingProvider.status, 400);

  const refused = await call("POST", "/admin/sms-formats", superToken, { provider: "edahab", sms: "Mahadsanid" });
  assert.equal(refused.status, 422, "a format that fails its test can't be activated");
  assert.equal((await query(`SELECT id FROM sms_format_rules`)).length, 0);

  // Adjusting a field and retesting: picking the balance as the amount is possible but visible.
  const adjusted = await (
    await call("POST", "/admin/sms-formats/test", superToken, { provider: "edahab", sms: NEW_EDAHAB, choice: { amountIndex: 1 } })
  ).json() as any;
  assert.equal(adjusted.extracted.amount, 0.77);
});

test("Save & Activate versions formats, keeps history with who did it, and restores an older one", async () => {
  const v1 = await call("POST", "/admin/sms-formats", superToken, { provider: "edahab", sms: OLD_EDAHAB, note: "older wording" });
  assert.equal(v1.status, 201, await v1.clone().text());
  const v2 = await call("POST", "/admin/sms-formats", superToken, { provider: "edahab", sms: NEW_EDAHAB, note: "Oct 2026 wording" });
  const v2Body = await v2.json() as any;
  assert.equal(v2.status, 201);
  assert.equal(v2Body.version, 2);

  const rows = await query<{ version: number; status: string }>(`SELECT version, status FROM sms_format_rules WHERE provider='edahab' ORDER BY version`);
  assert.deepEqual(rows.map((r) => [r.version, r.status]), [[1, "inactive"], [2, "active"]]);

  const agentView = await (await call("GET", "/agent/sms-formats", agentToken)).json() as any;
  assert.equal(agentView.length, 1);
  assert.equal(agentView[0].version, 2);
  assert.equal(agentView[0].parsedProvider, "Somtel");
  assert.deepEqual(agentView[0].senders, ["eDahab"]);

  const v1Id = (await queryOne<{ id: string }>(`SELECT id FROM sms_format_rules WHERE provider='edahab' AND version=1`))!.id;
  const restore = await call("POST", `/admin/sms-formats/${v1Id}/activate`, superToken);
  assert.equal(restore.status, 200);
  assert.equal((await queryOne<{ version: number }>(`SELECT version FROM sms_format_rules WHERE provider='edahab' AND status='active'`))!.version, 1);

  const overview = await (await call("GET", "/admin/sms-formats", superToken)).json() as any;
  const actions = overview.events.filter((e: any) => e.provider === "edahab").map((e: any) => e.action);
  assert.deepEqual(actions.slice(0, 3), ["restored", "activated", "created"]);
  assert.ok(overview.events.every((e: any) => e.adminEmail === "fmt-super@test.local"));
  assert.equal(overview.rules.find((r: any) => r.version === 2).createdByEmail, "fmt-super@test.local");

  // Back to the newest wording for the rest of the tests.
  const v2Id = (await queryOne<{ id: string }>(`SELECT id FROM sms_format_rules WHERE provider='edahab' AND version=2`))!.id;
  assert.equal((await call("POST", `/admin/sms-formats/${v2Id}/activate`, superToken)).status, 200);
});

test("changing one provider's format leaves every other provider's active format untouched", async () => {
  const somnet = await call("POST", "/admin/sms-formats", superToken, { provider: "somnet", sms: SOMNET });
  assert.equal(somnet.status, 201, await somnet.clone().text());
  const before = await query(`SELECT id, status FROM sms_format_rules WHERE provider='somnet'`);
  assert.equal((await call("POST", "/admin/sms-formats", superToken, { provider: "edahab", sms: NEW_EDAHAB })).status, 201);
  assert.deepEqual(await query(`SELECT id, status FROM sms_format_rules WHERE provider='somnet'`), before);

  // An EVC Plus format with keywords Somnet's SMS also has is refused.
  const clash = await call("POST", "/admin/sms-formats", superToken, { provider: "evc_plus", sms: HORMUUD, keywords: ["ka heshay"] });
  assert.equal(clash.status, 422);
  assert.match((await clash.json() as any).error, /Somnet/);

  // Turning a provider's format off falls back to the app's built-in reading.
  const off = await call("POST", "/admin/sms-formats/providers/somnet/deactivate", superToken);
  assert.equal(off.status, 200);
  assert.equal((await query(`SELECT id FROM sms_format_rules WHERE provider='somnet' AND status='active'`)).length, 0);
});

test("an SMS the app couldn't read is read on the server, matched, but NOT marked paid without verification", async () => {
  clearSmsFormatCache();
  await query(
    `INSERT INTO orders (id, customer_id, company_id, package_id, amount, status, sender_phone, receiver_phone)
     VALUES ('FMTTEST1',$1,$2,$3,0.09,'pending','620346060','252611111177')`,
    [CUSTOMER_ID, COMPANY, PACKAGE_ID]
  );
  const result = await ingestPaymentSms({ agentId: AGENT_ID, sender: "eDahab", body: NEW_EDAHAB, receivedAt: new Date().toISOString() });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.matchedOrderId, "FMTTEST1");
  const sms = await queryOne<any>(`SELECT parsed_provider, parsed_amount, parsed_phone, transaction_ref FROM sms_logs WHERE id=$1`, [result.body.id]);
  assert.equal(sms.parsed_provider, "Somtel");
  assert.equal(Number(sms.parsed_amount), 0.09);
  assert.equal(sms.parsed_phone, "620346060");
  assert.equal(sms.transaction_ref, "PP261009.1511.117314");
  const order = await queryOne<{ status: string }>(`SELECT status FROM orders WHERE id='FMTTEST1'`);
  assert.equal(order!.status, "pending", "reading + matching an SMS must not mark the order paid by itself");

  // The same payment again (re-delivered SMS, inbox re-scan) is refused by its reference.
  const again = await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "eDahab",
    body: NEW_EDAHAB + " ",
    receivedAt: new Date(Date.now() + 120_000).toISOString(),
  });
  assert.equal(again.body.duplicate, true);
  const ledger = await query<{ status: string }>(`SELECT status FROM payment_transactions WHERE transaction_ref='PP261009.1511.117314' ORDER BY status`);
  assert.deepEqual(
    ledger.map((r) => r.status),
    ["duplicate_blocked", "pending"],
    "one real payment entry; the repeat is only recorded as blocked"
  );
});

test("an SMS from a different sender is never read by another provider's format", async () => {
  const result = await ingestPaymentSms({ agentId: AGENT_ID, sender: "192", body: NEW_EDAHAB.replace("PP261009.1511.117314", "PP261009.0000.X1"), receivedAt: new Date().toISOString() });
  const sms = await queryOne<any>(`SELECT parsed_amount FROM sms_logs WHERE id=$1`, [result.body.id]);
  assert.equal(sms.parsed_amount, null);
});

test("activating a format reads recent unread SMS once, and skips ones whose reference was already processed", async () => {
  await query(`DELETE FROM sms_format_rules WHERE provider='hormuud'`);
  const body = "[-EVCPLUS-] waxaad $0.35 ka heshay 0610000111, Tix: HR261009.77, Tar: 09/10/26";
  const unreadId = randomUUID();
  await query(`INSERT INTO sms_logs (id, agent_id, sender, body, received_at) VALUES ($1,$2,'192',$3, now() - interval '1 hour')`, [unreadId, AGENT_ID, body]);
  await query(
    `INSERT INTO payment_transactions (id, sms_log_id, status, payment_timestamp) VALUES ($1,$2,'pending', now())`,
    [randomUUID(), unreadId]
  );
  const dupId = randomUUID();
  await query(`INSERT INTO sms_logs (id, agent_id, sender, body, received_at) VALUES ($1,$2,'192',$3, now() - interval '50 minutes')`, [
    dupId,
    AGENT_ID,
    body.replace("$0.35", "$0.36").replace("HR261009.77", "PP261009.1511.117314"),
  ]);

  const saved = await call("POST", "/admin/sms-formats", superToken, { provider: "hormuud", sms: body });
  const savedBody = await saved.json() as any;
  assert.equal(saved.status, 201, JSON.stringify(savedBody));
  assert.equal(savedBody.recentSmsRead, 1);

  const unread = await queryOne<any>(`SELECT parsed_amount, parsed_phone, transaction_ref FROM sms_logs WHERE id=$1`, [unreadId]);
  assert.equal(Number(unread.parsed_amount), 0.35);
  assert.equal(unread.parsed_phone, "0610000111");
  assert.equal(unread.transaction_ref, "HR261009.77");
  const ledger = await queryOne<any>(`SELECT amount, transaction_ref FROM payment_transactions WHERE sms_log_id=$1`, [unreadId]);
  assert.equal(Number(ledger.amount), 0.35);
  assert.equal(ledger.transaction_ref, "HR261009.77");

  const dup = await queryOne<any>(`SELECT parsed_amount, match_failure_reason FROM sms_logs WHERE id=$1`, [dupId]);
  assert.equal(dup.parsed_amount, null, "an already-processed reference must not become a second payment");
  assert.match(dup.match_failure_reason, /Already processed/);
});
