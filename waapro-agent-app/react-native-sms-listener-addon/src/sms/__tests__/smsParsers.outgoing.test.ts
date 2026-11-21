/// <reference types="node" />
//
// Run via tsx (this package had zero test tooling before this file —
// tsx + @types/node were added as devDependencies specifically for this):
//
//   npm test
//   (equivalent to: npx tsx --test src/sms/__tests__/smsParsers.outgoing.test.ts)
//
// Covers the two real Reseller Withdraw ("Lacag Bixi") outgoing-payment
// SMS samples this project has actually seen, one per company — see
// hormuudOutgoingParser/amtelOutgoingParser in smsParsers.ts. Each
// company's format is confirmed against its own real sample; nothing here
// is guessed, and Somtel/Somnet deliberately have no parser yet since no
// real sample exists for either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hormuudOutgoingParser, amtelOutgoingParser, parsePaymentSms, hormuudParser, amtelParser } from "../smsParsers.js";
import type { RawSms } from "../../types/sms.js";

function raw(sender: string, body: string): RawSms {
  return { sender, body, timestampMs: Date.parse("2026-08-18T00:00:00Z") };
}

test("Hormuud outgoing: real sample parses to the correct amount and destination phone", () => {
  const sms = raw("740", "[-E-Voucher-] $0.5 ayaad uwareejisay YAASIIN MAXAMED AADAN(617080008), Haraagaagu waa $2.37.");
  const parsed = hormuudOutgoingParser.tryParse(sms);
  assert.ok(parsed, "must parse");
  assert.equal(parsed!.operator, "Hormuud");
  assert.equal(parsed!.amount, 0.5);
  assert.equal(parsed!.customerPhone, "617080008");
});

test("Amtel outgoing: real sample parses to the correct amount, destination phone, and timestamp", () => {
  const sms = raw(
    "913",
    "You have transferred $1-252711444497. Date-Time: 18/08/2026 09:04:48. Transaction ID: 04247700000025841807. Your balance $0.35."
  );
  const parsed = amtelOutgoingParser.tryParse(sms);
  assert.ok(parsed, "must parse");
  assert.equal(parsed!.operator, "Amtel");
  assert.equal(parsed!.amount, 1);
  assert.equal(parsed!.customerPhone, "252711444497");
  assert.equal(parsed!.transactionDateTime, "2026-08-18T09:04:48.000Z");
});

test("Hormuud's outgoing parser never matches an Amtel-sender SMS, and vice versa — no shared regex between companies", () => {
  const amtelBody = "You have transferred $1-252711444497. Date-Time: 18/08/2026 09:04:48. Transaction ID: 04247700000025841807. Your balance $0.35.";
  assert.equal(hormuudOutgoingParser.tryParse(raw("913", amtelBody)), null);

  const hormuudBody = "[-E-Voucher-] $0.5 ayaad uwareejisay YAASIIN MAXAMED AADAN(617080008), Haraagaagu waa $2.37.";
  assert.equal(amtelOutgoingParser.tryParse(raw("740", hormuudBody)), null);
});

test("parsePaymentSms routes both real outgoing samples correctly through the combined incoming+outgoing pipeline", () => {
  const hormuudResult = parsePaymentSms(
    raw("740", "[-E-Voucher-] $0.5 ayaad uwareejisay YAASIIN MAXAMED AADAN(617080008), Haraagaagu waa $2.37.")
  );
  assert.ok(hormuudResult);
  assert.equal(hormuudResult!.amount, 0.5);

  const amtelResult = parsePaymentSms(
    raw("913", "You have transferred $1-252711444497. Date-Time: 18/08/2026 09:04:48. Transaction ID: 04247700000025841807. Your balance $0.35.")
  );
  assert.ok(amtelResult);
  assert.equal(amtelResult!.amount, 1);
});

test("existing INCOMING parsers (received-payment SMS) are completely unaffected by the new outgoing parsers", () => {
  const hormuudIncoming = hormuudParser.tryParse(raw("192", "waxaad $5 ka heshay 615551234, Tar: 18/08/26"));
  assert.ok(hormuudIncoming);
  assert.equal(hormuudIncoming!.amount, 5);

  const amtelIncoming = amtelParser.tryParse(raw("AMTEL", "received $5 from 615551234"));
  assert.ok(amtelIncoming);
  assert.equal(amtelIncoming!.amount, 5);
});
