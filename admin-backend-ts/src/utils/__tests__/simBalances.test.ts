// Run against a real local Postgres test database (see offlineAutoOrder.test.ts
// for the exact invocation pattern):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/utils/__tests__/simBalances.test.ts
//
// Covers the Balance Dashboard fix: provider balances must come from the
// LATEST valid balance SMS actually received on that provider's own
// physical SIM, never from a phrase-guessed "provider" label (the confirmed
// root cause of Hormuud's own balance showing up on Somnet's dashboard
// card -- both providers phrase their "remaining balance" line identically).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, queryOne, pool } from "../../db/pool.js";
import { extractBalanceFromSms, isExpectedBalanceSender, BALANCE_SENDER_ID } from "../simBalances.js";
import { ingestPaymentSms } from "../../routes/smsLogs.routes.js";

// ---------------------------------------------------------------------------
// Part 1: extractBalanceFromSms -- pure parsing, no DB, using the exact real
// SMS bodies confirmed against live devices for all four providers.
// ---------------------------------------------------------------------------

test("extracts EVC Plus's real balance phrase (single-'a' \"haraagagu\" spelling)", () => {
  const body = "[-EVCPLUS-] waxaad $0.75 ka heshay 0619991299, Tar: 26/08/26 19:45:13 haraagagu waa $2.965.\nLa soo deg App-ka WAAFI\nhttp://onelink.to/waafi";
  assert.deepEqual(extractBalanceFromSms(body), { balance: 2.965 });
});

test("extracts Hormuud E-Voucher's balance phrase (double-'a' \"Haraagaagu\" spelling)", () => {
  const body = "[-E-Voucher-] Waxaad $0.8 ugu shubtay 252610808086, Haraagaagu waa $1.64.\nLa soo deg App-ka WAAFI\nhttp://onelink.to/waafi";
  assert.deepEqual(extractBalanceFromSms(body), { balance: 1.64 });
});

test("extracts Somnet/Jeeb's balance phrase from a [Jeeb] outgoing-transfer confirmation", () => {
  const body =
    "[Jeeb] Tix: 2559004693, $ 1.18 ayaad u dirtay CABDIRISAQ MAXAMED CALI(687031955) Tar 26/08/26 00:43:15, Haraagaagu waa $0.19.";
  assert.deepEqual(extractBalanceFromSms(body), { balance: 0.19 });
});

test("extracts Somtel's reseller-transfer balance phrase (colon, no '$' sign)", () => {
  const body = "Yaasiin, waxaad ku guulaysatay inaad lambarkan 620338686 u wareejiso  0.70 oo Dhammays ah.\nHaraagaagu waa:  5.50.\nMahadsanid!";
  assert.deepEqual(extractBalanceFromSms(body), { balance: 5.5 });
});

test("extracts eDahab/Somtel's own distinct 'Cusubi Waa' balance phrase", () => {
  const body =
    "1 Dollar Ayaad Ka Heshay Yaasiin Maxamed Aadan.Code-ka:NA.Lambarka :620346060Aqanoosiga : PP260825.1816.F72841  Haraagaaga Cusubi Waa: 31.34 Dollar..Tariikh:25-08-2026[-eDahab-Service-]";
  assert.deepEqual(extractBalanceFromSms(body), { balance: 31.34 });
});

test("extracts Amtel's balance phrase, tolerating the literal '+' sign", () => {
  const body =
    "Your Transfer Airtime to 252711444497 - 252711444497 has been successfully processed on 25/08/2026 22:41:36, TransactionID is 0425430000026121993; Amount is $+1.20. Now your balance is $+1.15.";
  assert.deepEqual(extractBalanceFromSms(body), { balance: 1.15 });
});

test("returns null for a body with no recognizable balance phrase", () => {
  assert.equal(extractBalanceFromSms("Receiver Airtime Partner not found"), null);
  assert.equal(extractBalanceFromSms("Your OTP is 123456"), null);
});

// ---------------------------------------------------------------------------
// Part 1b: isExpectedBalanceSender/BALANCE_SENDER_ID -- the exact Sender ID
// gate itself, no DB involved. Required mapping (Balance Update Fix):
// EVC Plus -> 192sms, eDahab -> edahabsms, Hormuud -> sms740,
// Somtel -> smsReseller, Amtel -> sms913, Somnet -> sms801.
// ---------------------------------------------------------------------------

const REQUIRED_BALANCE_SENDER_MAPPING: Array<[string, string]> = [
  ["evc_plus", "192sms"],
  ["edahab", "edahabsms"],
  ["hormuud", "sms740"],
  ["somtel", "smsReseller"],
  ["amtel", "sms913"],
  ["somnet", "sms801"],
];

for (const [provider, expectedSender] of REQUIRED_BALANCE_SENDER_MAPPING) {
  test(`BALANCE_SENDER_ID.${provider} is exactly "${expectedSender}"`, () => {
    assert.equal(BALANCE_SENDER_ID[provider], expectedSender);
  });

  test(`isExpectedBalanceSender("${provider}", ...) accepts only its own Sender ID "${expectedSender}"`, () => {
    assert.equal(isExpectedBalanceSender(provider, expectedSender), true);
    // Case/whitespace tolerance is the only slack allowed -- the identity
    // itself must still match exactly.
    assert.equal(isExpectedBalanceSender(provider, expectedSender.toUpperCase()), true);
    assert.equal(isExpectedBalanceSender(provider, `  ${expectedSender}  `), true);
  });
}

test("isExpectedBalanceSender never falls back to another provider's Sender ID (requirement 3)", () => {
  for (const [provider] of REQUIRED_BALANCE_SENDER_MAPPING) {
    for (const [otherProvider, otherSender] of REQUIRED_BALANCE_SENDER_MAPPING) {
      if (otherProvider === provider) continue;
      assert.equal(
        isExpectedBalanceSender(provider, otherSender),
        false,
        `${provider} must never accept ${otherProvider}'s Sender ID "${otherSender}"`
      );
    }
  }
});

test("isExpectedBalanceSender rejects an unrecognized provider identity or a missing sender (requirement 5)", () => {
  assert.equal(isExpectedBalanceSender("unknown_provider", "sms740"), false);
  assert.equal(isExpectedBalanceSender("hormuud", null), false);
  assert.equal(isExpectedBalanceSender("hormuud", undefined), false);
  assert.equal(isExpectedBalanceSender("hormuud", ""), false);
});

// ---------------------------------------------------------------------------
// Part 2: end-to-end via ingestPaymentSms -- attribution must come from
// which physical device+SIM-slot the SMS arrived on (sim_routing), and the
// latest valid SMS for a given SIM must always win over an older one.
// ---------------------------------------------------------------------------

// Each physical Android device runs its own agent-app login (agents.device_id
// is a fixed 1:1 mapping), so a balance SMS "arriving on device 2" in real
// life means it was uploaded by AGENT2_ID, not AGENT_ID with a different
// simSlot -- these mirror that: AGENT_ID/DEVICE_ID hosts Hormuud (slot 1) +
// Somtel (slot 2), exactly like "Mobile 1" in the real dashboard; AGENT2_ID/
// DEVICE2_ID hosts Somnet (slot 1) + Amtel (slot 2), like "Mobile 2".
// AGENT3_ID/DEVICE3_ID is deliberately never registered in sim_routing at
// all, for the "unrouted device" guardrail test.
const AGENT_ID = randomUUID();
const AGENT2_ID = randomUUID();
const AGENT3_ID = randomUUID();
const DEVICE_ID = "test-balance-device";
const DEVICE2_ID = "test-balance-device-2";
const DEVICE3_ID = "test-balance-device-3-unrouted";
const HORMUUD_ID = "test-balance-hormuud";
const SOMTEL_ID = "test-balance-somtel";
const SOMNET_ID = "test-balance-somnet";
const AMTEL_ID = "test-balance-amtel";

async function currentBalance(deviceId: string, simSlot: number) {
  return queryOne<{ balance: string | null; company_id: string | null }>(
    `SELECT balance, company_id FROM sim_balances WHERE device_id=$1 AND sim_slot=$2`,
    [deviceId, simSlot]
  );
}

before(async () => {
  await query(`DELETE FROM sms_logs`);
  await query(`DELETE FROM payment_transactions`);
  await query(`DELETE FROM sim_balance_history`);
  await query(`DELETE FROM sim_balances`);
  await query(`DELETE FROM company_payment_methods WHERE device_id IN ($1,$2,$3)`, [DEVICE_ID, DEVICE2_ID, DEVICE3_ID]);
  await query(`DELETE FROM sim_routing WHERE company_id IN ($1,$2,$3,$4)`, [HORMUUD_ID, SOMTEL_ID, SOMNET_ID, AMTEL_ID]);
  await query(`DELETE FROM companies WHERE id IN ($1,$2,$3,$4)`, [HORMUUD_ID, SOMTEL_ID, SOMNET_ID, AMTEL_ID]);
  await query(`DELETE FROM agents WHERE id IN ($1,$2,$3)`, [AGENT_ID, AGENT2_ID, AGENT3_ID]);
  await query(`DELETE FROM agent_devices WHERE id IN ($1,$2,$3)`, [DEVICE_ID, DEVICE2_ID, DEVICE3_ID]);

  await query(`INSERT INTO agent_devices (id, name, sim1_present, sim2_present) VALUES ($1, 'Test Balance Device', true, true)`, [DEVICE_ID]);
  await query(`INSERT INTO agent_devices (id, name, sim1_present, sim2_present) VALUES ($1, 'Test Balance Device 2', true, true)`, [DEVICE2_ID]);
  await query(`INSERT INTO agent_devices (id, name, sim1_present, sim2_present) VALUES ($1, 'Test Balance Device 3 (unrouted)', true, true)`, [
    DEVICE3_ID,
  ]);

  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000088', 'Balance Test Agent 1', 'x', $2)`, [
    AGENT_ID,
    DEVICE_ID,
  ]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000089', 'Balance Test Agent 2', 'x', $2)`, [
    AGENT2_ID,
    DEVICE2_ID,
  ]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, device_id) VALUES ($1, '252699000090', 'Balance Test Agent 3', 'x', $2)`, [
    AGENT3_ID,
    DEVICE3_ID,
  ]);

  for (const [id, name, group] of [
    [HORMUUD_ID, "Hormuud", 1],
    [SOMTEL_ID, "Somtel", 2],
    [SOMNET_ID, "Somnet", 1],
    [AMTEL_ID, "Amtel", 2],
  ] as const) {
    await query(`INSERT INTO companies (id, name, group_number, color_hex, gateway) VALUES ($1,$2,$3,'#000000','manual')`, [id, name, group]);
  }

  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot, priority) VALUES ($1,$2,1,1)`, [HORMUUD_ID, DEVICE_ID]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot, priority) VALUES ($1,$2,2,1)`, [SOMTEL_ID, DEVICE_ID]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot, priority) VALUES ($1,$2,1,1)`, [SOMNET_ID, DEVICE2_ID]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot, priority) VALUES ($1,$2,2,1)`, [AMTEL_ID, DEVICE2_ID]);
  // DEVICE3_ID intentionally has no sim_routing rows at all.
});

after(async () => {
  // sim_routing's (company_id, device_id) primary key makes device_id
  // implicitly NOT NULL, so a leftover row here referencing one of this
  // suite's test devices would break any OTHER test file's blanket `DELETE
  // FROM agent_devices` (its ON DELETE SET NULL action would violate that
  // NOT NULL) -- clean up everything this suite created, not just close
  // the pool.
  await query(`DELETE FROM sms_logs WHERE agent_id IN ($1,$2,$3)`, [AGENT_ID, AGENT2_ID, AGENT3_ID]);
  await query(`DELETE FROM payment_transactions WHERE sms_log_id IN (SELECT id FROM sms_logs WHERE agent_id IN ($1,$2,$3))`, [
    AGENT_ID,
    AGENT2_ID,
    AGENT3_ID,
  ]).catch(() => {});
  await query(`DELETE FROM sim_balance_history`);
  await query(`DELETE FROM sim_balances`);
  await query(`DELETE FROM company_payment_methods WHERE device_id IN ($1,$2,$3)`, [DEVICE_ID, DEVICE2_ID, DEVICE3_ID]);
  await query(`DELETE FROM sim_routing WHERE company_id IN ($1,$2,$3,$4)`, [HORMUUD_ID, SOMTEL_ID, SOMNET_ID, AMTEL_ID]);
  await query(`DELETE FROM companies WHERE id IN ($1,$2,$3,$4)`, [HORMUUD_ID, SOMTEL_ID, SOMNET_ID, AMTEL_ID]);
  await query(`DELETE FROM agents WHERE id IN ($1,$2,$3)`, [AGENT_ID, AGENT2_ID, AGENT3_ID]);
  await query(`DELETE FROM agent_devices WHERE id IN ($1,$2,$3)`, [DEVICE_ID, DEVICE2_ID, DEVICE3_ID]);
  await pool.end();
});

test("a Hormuud E-Voucher balance SMS updates ONLY Hormuud's SIM, never Somnet's -- even though both phrase 'remaining balance' identically", async () => {
  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "sms740", // Hormuud's own registered balance Sender ID (BALANCE_SENDER_ID.hormuud)
    body: "[-E-Voucher-] Waxaad $0.8 ugu shubtay 252610808086, Haraagaagu waa $1.64.",
    simSlot: 1, // Hormuud's slot on the test device
  });

  const hormuud = await currentBalance(DEVICE_ID, 1);
  assert.equal(Number(hormuud?.balance), 1.64);
  assert.equal(hormuud?.company_id, HORMUUD_ID);

  const somnetDeviceId = DEVICE2_ID;
  const somnet = await currentBalance(somnetDeviceId, 1);
  assert.equal(somnet, null, "Hormuud's balance SMS must never create/touch Somnet's SIM balance row");
});

test("a Somnet/Jeeb balance SMS on Somnet's own SIM slot updates only Somnet, independently of Hormuud's value", async () => {
  const somnetDeviceId = DEVICE2_ID;
  await ingestPaymentSms({
    agentId: AGENT2_ID,
    sender: "sms801", // Somnet's own registered balance Sender ID (BALANCE_SENDER_ID.somnet)
    body: "[Jeeb] Tix: 2559004693, $ 1.18 ayaad u dirtay CABDIRISAQ MAXAMED CALI(687031955) Tar 26/08/26 00:43:15, Haraagaagu waa $0.19.",
    simSlot: 1,
  });

  const somnet = await currentBalance(somnetDeviceId, 1);
  assert.equal(Number(somnet?.balance), 0.19);
  assert.equal(somnet?.company_id, SOMNET_ID);

  // Hormuud's own balance from the previous test must be untouched.
  const hormuud = await currentBalance(DEVICE_ID, 1);
  assert.equal(Number(hormuud?.balance), 1.64);
});

test("the LATEST valid balance SMS always wins, even when it reports a lower number than an earlier one", async () => {
  // All three arrive from Hormuud's own registered balance Sender ID
  // (sms740) -- this device+slot is only registered as Hormuud's top-up SIM
  // (sim_routing), not as an EVC Plus collection method, so an EVC Plus-
  // branded sender would now be correctly refused here (see the dedicated
  // EVC Plus/eDahab test below for that identity's own gate, on its own
  // device+slot). First $2.215, then a later SMS reports $2.965 -- the later
  // one must be what's stored regardless of arrival order semantics, since
  // applyBalanceUpdate always takes the most recently-processed value.
  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "sms740",
    body: "[-E-Voucher-] Waxaad $0.45 ugu shubtay 252619991299, Haraagaagu waa $2.215.",
    simSlot: 1,
  });
  let hormuud = await currentBalance(DEVICE_ID, 1);
  assert.equal(Number(hormuud?.balance), 2.215);

  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "sms740",
    body: "[-E-Voucher-] Waxaad $0.75 ugu shubtay 252619991299, Haraagaagu waa $2.965.",
    simSlot: 1,
  });
  hormuud = await currentBalance(DEVICE_ID, 1);
  assert.equal(Number(hormuud?.balance), 2.965, "the later SMS's balance must win over the earlier one");

  // A third SMS reporting a SMALLER number must still overwrite -- "latest
  // wins" is about arrival order, not magnitude.
  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "sms740",
    body: "[-E-Voucher-] Waxaad $0.5 ugu shubtay 252619991299, Haraagaagu waa $1.64.",
    simSlot: 1,
  });
  hormuud = await currentBalance(DEVICE_ID, 1);
  assert.equal(Number(hormuud?.balance), 1.64);
});

test("Amtel's '+'-sign balance format is parsed and attributed to Amtel's own SIM", async () => {
  const amtelDeviceId = DEVICE2_ID;
  await ingestPaymentSms({
    agentId: AGENT2_ID,
    sender: "sms913", // Amtel's own registered balance Sender ID (BALANCE_SENDER_ID.amtel)
    body: "Your Transfer Airtime to 252711444497 - 252711444497 has been successfully processed on 25/08/2026 22:41:36, TransactionID is 0425430000026121993; Amount is $+1.20. Now your balance is $+1.15.",
    simSlot: 2,
  });

  const amtel = await currentBalance(amtelDeviceId, 2);
  assert.equal(Number(amtel?.balance), 1.15);
  assert.equal(amtel?.company_id, AMTEL_ID);
});

test("a balance SMS on an unrouted device+slot updates nothing rather than guessing a provider", async () => {
  await ingestPaymentSms({
    agentId: AGENT3_ID,
    sender: "801",
    body: "[Jeeb] Tix: 1, $1 ayaad u dirtay SOMEONE(687000000) Tar 26/08/26 00:00:00, Haraagaagu waa $9.99.",
    simSlot: 1,
  });

  const row = await currentBalance(DEVICE3_ID, 1);
  assert.equal(row, null, "no sim_routing entry for this device+slot means no company to attribute to -- must not invent one");
});

test("a balance SMS with an unresolved SIM slot updates nothing rather than guessing which of the device's SIMs it was", async () => {
  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "sms740",
    body: "[-E-Voucher-] Waxaad $0.1 ugu shubtay 252610808086, Haraagaagu waa $77.00.",
    simSlot: null,
  });

  // Neither of this device's two slots should have picked up $77 -- Hormuud
  // (slot 1) must still hold the value from the previous test, and Somtel
  // (slot 2, never touched by these tests) must still have no row at all.
  const hormuud = await currentBalance(DEVICE_ID, 1);
  assert.equal(Number(hormuud?.balance), 1.64);
  const somtel = await currentBalance(DEVICE_ID, 2);
  assert.equal(somtel, null);
});

// ---------------------------------------------------------------------------
// Part 3: Balance Update Fix -- provider-specific Sender ID gate end-to-end.
// Each of the 6 providers is read only from ITS OWN exact Sender ID; a
// balance SMS with the right body/device/slot but the WRONG sender must be
// logged and skipped, never applied -- even to the provider it actually
// physically arrived for, let alone another provider's balance.
// ---------------------------------------------------------------------------

test("Somtel's own reseller-transfer balance SMS, sent from its registered Sender ID, updates only Somtel", async () => {
  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "smsReseller", // BALANCE_SENDER_ID.somtel
    body: "Yaasiin, waxaad ku guulaysatay inaad lambarkan 620338686 u wareejiso  0.70 oo Dhammays ah.\nHaraagaagu waa:  5.50.\nMahadsanid!",
    simSlot: 2, // Somtel's slot on the test device
  });

  const somtel = await currentBalance(DEVICE_ID, 2);
  assert.equal(Number(somtel?.balance), 5.5);
  assert.equal(somtel?.company_id, SOMTEL_ID);
});

test("a real balance SMS that physically arrives on Hormuud's own SIM slot is REFUSED when its sender isn't Hormuud's registered Sender ID", async () => {
  // Same device+slot Hormuud already holds a confirmed $1.64 balance on
  // (from an earlier test in this file) -- a wrong-sender SMS reporting a
  // wildly different number must leave that value completely untouched.
  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "unknown-short-code",
    body: "[-E-Voucher-] Waxaad $9 ugu shubtay 252610808086, Haraagaagu waa $999.99.",
    simSlot: 1,
  });

  const hormuud = await currentBalance(DEVICE_ID, 1);
  assert.equal(Number(hormuud?.balance), 1.64, "an SMS from an unrecognized sender must never overwrite a provider's confirmed balance");
});

test("requirement 3: another provider's OWN real Sender ID is still refused on a SIM slot it doesn't belong to (no cross-provider fallback)", async () => {
  // "sms801" is Somnet's real, valid Sender ID -- but this SMS lands on
  // Hormuud's slot (device 1, slot 1). A correct-for-someone-else sender is
  // still the wrong sender for Hormuud and must be refused exactly like a
  // garbage one.
  await ingestPaymentSms({
    agentId: AGENT_ID,
    sender: "sms801",
    body: "[-E-Voucher-] Waxaad $9 ugu shubtay 252610808086, Haraagaagu waa $888.88.",
    simSlot: 1,
  });

  const hormuud = await currentBalance(DEVICE_ID, 1);
  assert.equal(Number(hormuud?.balance), 1.64, "Somnet's real Sender ID must never be accepted as a fallback for Hormuud's SIM");
});

test("EVC Plus and eDahab collection SIMs (company_payment_methods.device_id/sim_slot) are attributed and gated by their own Sender ID, independent of sim_routing", async () => {
  // Both collection SIMs live on DEVICE3_ID, which has NO sim_routing rows
  // at all (it's the dedicated "unrouted device" fixture) -- proving
  // attribution here comes entirely from company_payment_methods, exactly
  // as it would for a real payment-collection phone that never dials
  // top-up USSD.
  const evcMethodId = randomUUID();
  const edahabMethodId = randomUUID();
  await query(
    `INSERT INTO company_payment_methods (id, company_id, method, label, device_id, sim_slot) VALUES ($1,$2,'evc_plus','EVC Plus',$3,1)`,
    [evcMethodId, HORMUUD_ID, DEVICE3_ID]
  );
  await query(
    `INSERT INTO company_payment_methods (id, company_id, method, label, device_id, sim_slot) VALUES ($1,$2,'edahab','eDahab',$3,2)`,
    [edahabMethodId, SOMTEL_ID, DEVICE3_ID]
  );

  try {
    // Wrong sender first -- must be refused on both slots.
    await ingestPaymentSms({
      agentId: AGENT3_ID,
      sender: "192", // NOT the required "192sms"
      body: "[-EVCPLUS-] waxaad $0.45 ka heshay 0619991299, Tar: 26/08/26 19:39:31 haraagagu waa $2.215.",
      simSlot: 1,
    });
    assert.equal(await currentBalance(DEVICE3_ID, 1), null, "EVC Plus must not update from a near-miss sender (\"192\" instead of \"192sms\")");

    // Correct sender -- must update, attributed to Hormuud (EVC Plus's own company).
    await ingestPaymentSms({
      agentId: AGENT3_ID,
      sender: "192sms",
      body: "[-EVCPLUS-] waxaad $0.45 ka heshay 0619991299, Tar: 26/08/26 19:39:31 haraagagu waa $2.215.",
      simSlot: 1,
    });
    const evc = await currentBalance(DEVICE3_ID, 1);
    assert.equal(Number(evc?.balance), 2.215);
    assert.equal(evc?.company_id, HORMUUD_ID);

    // eDahab on the same device's OTHER slot -- wrong sender refused, correct sender accepted.
    await ingestPaymentSms({
      agentId: AGENT3_ID,
      sender: "edahab", // NOT the required "edahabsms"
      body: "1 Dollar Ayaad Ka Heshay Yaasiin Maxamed Aadan.Code-ka:NA.Lambarka :620346060Aqanoosiga : PP260825.1816.F72841  Haraagaaga Cusubi Waa: 31.34 Dollar..Tariikh:25-08-2026[-eDahab-Service-]",
      simSlot: 2,
    });
    assert.equal(await currentBalance(DEVICE3_ID, 2), null, "eDahab must not update from a near-miss sender (\"edahab\" instead of \"edahabsms\")");

    await ingestPaymentSms({
      agentId: AGENT3_ID,
      sender: "edahabsms",
      body: "1 Dollar Ayaad Ka Heshay Yaasiin Maxamed Aadan.Code-ka:NA.Lambarka :620346060Aqanoosiga : PP260825.1816.F72841  Haraagaaga Cusubi Waa: 31.34 Dollar..Tariikh:25-08-2026[-eDahab-Service-]",
      simSlot: 2,
    });
    const edahab = await currentBalance(DEVICE3_ID, 2);
    assert.equal(Number(edahab?.balance), 31.34);
    assert.equal(edahab?.company_id, SOMTEL_ID);

    // And critically: EVC Plus's balance (Hormuud's own top-up SIM on
    // DEVICE_ID, slot 1) must remain completely independent of EVC Plus's
    // OWN collection SIM balance on DEVICE3_ID -- two different physical
    // SIMs for the same company, never conflated.
    const hormuudTopUp = await currentBalance(DEVICE_ID, 1);
    assert.equal(Number(hormuudTopUp?.balance), 1.64);
  } finally {
    await query(`DELETE FROM company_payment_methods WHERE id IN ($1,$2)`, [evcMethodId, edahabMethodId]);
  }
});
