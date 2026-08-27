// Run against a real local Postgres test database (see offlineAutoOrder.test.ts
// for the exact invocation pattern):
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dalab_test PGSSL=false \
//     npx tsx --test src/routes/__tests__/financeOverview.test.ts
//
// Covers requirement 6/7 from the Balance Dashboard fix follow-up: the
// Financial Overview's "Total Money Available"/"Current Wallet Balance"
// must come from the EXACT SAME canonical source (SIM_BALANCE_LIST_SQL,
// shared with the Balance Dashboard) as the Balance Dashboard, never a
// second hand-maintained figure, and it must never invent a contribution
// for a SIM with no confirmed balance.
//
// Assertions use BEFORE/AFTER deltas rather than absolute totals: this
// endpoint's universe is intentionally every device/slot in the whole
// system (matching the Balance Dashboard exactly), and other test files in
// this shared test database leave their own devices behind (e.g.
// offlineAutoOrder.test.ts's "test-offline-device" is never deleted) --
// an absolute-total assertion would be order-dependent on which other
// suites already ran, which is not what this file is testing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { financeRouter } from "../finance.routes.js";
import { simBalancesRouter } from "../simBalances.routes.js";

const app = express();
app.use(express.json());
app.use(financeRouter);
app.use(simBalancesRouter);
let server: http.Server;
let baseUrl: string;
let staffToken: string;

const DEVICE_A = "test-finance-device-a";
const DEVICE_B = "test-finance-device-b";
const HORMUUD_ID = "test-finance-hormuud";
const SOMTEL_ID = "test-finance-somtel";
const SOMNET_ID = "test-finance-somnet";

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${staffToken}` } });
  return { status: res.status, body: await res.json() };
}

let baseline: { total: number; known: number; totalSims: number };

before(async () => {
  await query(`DELETE FROM sim_balance_history`);
  await query(`DELETE FROM sim_balances WHERE device_id IN ($1,$2)`, [DEVICE_A, DEVICE_B]);
  await query(`DELETE FROM sim_routing WHERE company_id IN ($1,$2,$3)`, [HORMUUD_ID, SOMTEL_ID, SOMNET_ID]);
  await query(`DELETE FROM companies WHERE id IN ($1,$2,$3)`, [HORMUUD_ID, SOMTEL_ID, SOMNET_ID]);
  await query(`DELETE FROM agent_devices WHERE id IN ($1,$2)`, [DEVICE_A, DEVICE_B]);

  staffToken = signAccessToken(randomUUID(), "super_admin");
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  // Baseline BEFORE this suite's own devices exist, so every later
  // assertion can check "moved by exactly what we added", regardless of
  // what other test files in this shared database have left behind.
  const before0 = await getJson("/admin/finance/overview");
  baseline = {
    total: Number(before0.body.totalMoneyAvailable),
    known: Number(before0.body.walletKnownSimCount),
    totalSims: Number(before0.body.walletTotalSimCount),
  };

  await query(`INSERT INTO agent_devices (id, name, sim1_present, sim2_present) VALUES ($1, 'Finance Test Device A', true, true)`, [DEVICE_A]);
  await query(`INSERT INTO agent_devices (id, name, sim1_present, sim2_present) VALUES ($1, 'Finance Test Device B', true, true)`, [DEVICE_B]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Hormuud',1,'#000000')`, [HORMUUD_ID]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Somtel',2,'#111111')`, [SOMTEL_ID]);
  await query(`INSERT INTO companies (id, name, group_number, color_hex) VALUES ($1,'Somnet',1,'#222222')`, [SOMNET_ID]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot, priority) VALUES ($1,$2,1,1)`, [HORMUUD_ID, DEVICE_A]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot, priority) VALUES ($1,$2,2,1)`, [SOMTEL_ID, DEVICE_A]);
  await query(`INSERT INTO sim_routing (company_id, device_id, sim_slot, priority) VALUES ($1,$2,1,1)`, [SOMNET_ID, DEVICE_B]);
  // DEVICE_B slot 2 is deliberately left unrouted -- one more "unknown SIM"
  // slot in the universe, on top of Somnet's own not-yet-confirmed one.

  // Two confirmed real balances (as if a Balance Dashboard fix had just
  // processed their SMS). Somnet (device B, slot 1) and device B's own
  // slot 2 are deliberately left with NO sim_balances row at all -- exactly
  // what "no valid balance SMS has arrived yet" looks like in the schema.
  await query(
    `INSERT INTO sim_balances (id, device_id, sim_slot, company_id, balance, last_source) VALUES ($1,$2,1,$3,2.965,'sms')`,
    [randomUUID(), DEVICE_A, HORMUUD_ID]
  );
  await query(
    `INSERT INTO sim_balances (id, device_id, sim_slot, company_id, balance, last_source) VALUES ($1,$2,2,$3,31.34,'sms')`,
    [randomUUID(), DEVICE_A, SOMTEL_ID]
  );
});

after(async () => {
  await query(`DELETE FROM sim_balance_history`);
  await query(`DELETE FROM sim_balances WHERE device_id IN ($1,$2)`, [DEVICE_A, DEVICE_B]);
  await query(`DELETE FROM sim_routing WHERE company_id IN ($1,$2,$3)`, [HORMUUD_ID, SOMTEL_ID, SOMNET_ID]);
  await query(`DELETE FROM companies WHERE id IN ($1,$2,$3)`, [HORMUUD_ID, SOMTEL_ID, SOMNET_ID]);
  await query(`DELETE FROM agent_devices WHERE id IN ($1,$2)`, [DEVICE_A, DEVICE_B]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("Financial Overview's wallet total rises by exactly the two confirmed balances added, never inventing Somnet's or device B slot 2's unconfirmed SIMs as $0-and-hidden", async () => {
  const { status, body } = await getJson("/admin/finance/overview");
  assert.equal(status, 200);
  // 2.965 + 31.34, at full 3-decimal precision -- not rounded/truncated.
  assert.equal(Number((Number(body.totalMoneyAvailable) - baseline.total).toFixed(3)), 34.305);
  assert.equal(Number(body.currentWalletBalance), Number(body.totalMoneyAvailable));
  // Exactly 2 newly-known SIMs (Hormuud, Somtel); Somnet + device B slot 2
  // both add to the total SIM count without becoming "known".
  assert.equal(Number(body.walletKnownSimCount) - baseline.known, 2);
  assert.equal(Number(body.walletTotalSimCount) - baseline.totalSims, 4);
});

test("Financial Overview and the Balance Dashboard summary agree exactly -- same canonical source, not two figures kept in sync by hand", async () => {
  const [overview, dashboardSummary] = await Promise.all([
    getJson("/admin/finance/overview"),
    getJson("/admin/sim-balances/summary"),
  ]);
  assert.equal(Number(overview.body.totalMoneyAvailable), Number(dashboardSummary.body.totalBalance));
});

test("adding a Somnet balance (its first-ever confirmed SMS) immediately raises the Financial Overview total and known-SIM count -- no caching lag", async () => {
  const before1 = await getJson("/admin/finance/overview");
  await query(
    `INSERT INTO sim_balances (id, device_id, sim_slot, company_id, balance, last_source) VALUES ($1,$2,1,$3,0.19,'sms')`,
    [randomUUID(), DEVICE_B, SOMNET_ID]
  );
  const after1 = await getJson("/admin/finance/overview");
  assert.equal(Number((Number(after1.body.totalMoneyAvailable) - Number(before1.body.totalMoneyAvailable)).toFixed(3)), 0.19);
  assert.equal(Number(after1.body.walletKnownSimCount) - Number(before1.body.walletKnownSimCount), 1);
  // Total SIM count is unchanged -- Somnet's slot already existed in the
  // universe (via sim_routing), only its known-ness changed.
  assert.equal(after1.body.walletTotalSimCount, before1.body.walletTotalSimCount);
});

test("does not confuse wallet balance with money received/data cost/profit -- those stay independently computed from orders/finance_expenses", async () => {
  const before2 = await getJson("/admin/finance/overview");
  const beforeMoneyReceived = Number(before2.body.moneyReceived);
  const beforeDataCost = Number(before2.body.totalDataCost);
  assert.notEqual(Number(before2.body.totalMoneyAvailable), beforeMoneyReceived);

  // Move the wallet total again (a manual override this time, exercising
  // the same sim_balances table Balance Dashboard edits go through) and
  // confirm moneyReceived/totalDataCost — computed from orders/
  // finance_expenses, never from sim_balances — don't move with it.
  await query(`UPDATE sim_balances SET balance = balance + 100 WHERE company_id = $1`, [HORMUUD_ID]);
  const after2 = await getJson("/admin/finance/overview");
  assert.equal(Number((Number(after2.body.totalMoneyAvailable) - Number(before2.body.totalMoneyAvailable)).toFixed(3)), 100);
  assert.equal(Number(after2.body.moneyReceived), beforeMoneyReceived);
  assert.equal(Number(after2.body.totalDataCost), beforeDataCost);
});
