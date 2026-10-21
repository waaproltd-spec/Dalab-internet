// Run against a freshly migrated local Postgres test database:
//   FOOTBALL_JOBS=off MEDIA_DIR=/tmp/dalab-media-test DATABASE_URL=postgres://... PGSSL=false JWT_SECRET=... \
//     npx tsx --test --test-force-exit src/routes/__tests__/football.test.ts
//
// Ciyaaraha (football exact-score predictions): contest creation, images,
// predictions closing at the deadline, the earliest exact-score prediction
// winning, agent confirmation, the winner notification, reward recording
// without duplicates, disputes, postponement, cleanup, customer search and
// agent permissions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import { footballRouter, runFootballLifecycle, runMediaCleanup, maskPhone, publicName } from "../football.routes.js";

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(footballRouter);
let server: http.Server;
let base: string;

const ADMIN = randomUUID();
const AGENT = randomUUID();
const AGENT_OFF = randomUUID();
const AHMED = randomUUID();
const SAHRA = randomUUID();
const YUSUF = randomUUID();
let adminTok: string, agentTok: string, agentOffTok: string, ahmedTok: string, sahraTok: string, yusufTok: string;
const MEDIA = process.env.MEDIA_DIR || "/tmp/dalab-media-test";

// 1x1 PNG
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

before(async () => {
  process.env.MEDIA_DIR = MEDIA;
  await fs.rm(MEDIA, { recursive: true, force: true });
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,'football-admin@test.local','x','super_admin')`, [ADMIN]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, ciyaaraha_enabled) VALUES ($1,'252611000001','Agent On','x',true),($2,'252611000002','Agent Off','x',false)`, [AGENT, AGENT_OFF]);
  await query(
    `INSERT INTO customers (id, phone, name) VALUES ($1,'252610123456','Ahmed Ali'),($2,'252612345678','Sahra Maxamed'),($3,'252615678901','Yusuf Omar')`,
    [AHMED, SAHRA, YUSUF]
  );
  adminTok = signAccessToken(ADMIN, "super_admin");
  agentTok = signAccessToken(AGENT, "agent");
  agentOffTok = signAccessToken(AGENT_OFF, "agent");
  ahmedTok = signAccessToken(AHMED, "customer");
  sahraTok = signAccessToken(SAHRA, "customer");
  yusufTok = signAccessToken(YUSUF, "customer");
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

async function call(method: string, p: string, token?: string, body?: unknown) {
  const res = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

async function createContest(extra: Record<string, unknown> = {}) {
  const r = await call("POST", "/agent/football/contests", agentTok, {
    homeTeam: { name: "Real Madrid" }, awayTeam: { name: "Barcelona" }, league: "La Liga",
    kickoffAt: inHours(3), rewardLabel: "1 GB Internet", rewardCompanyId: "hormuud", publish: true, ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

/** Moves a contest's clock into the past (as if the deadline/kickoff passed). */
async function kickoffPassed(id: string, minutesAgo = 120) {
  await query(`UPDATE football_contests SET kickoff_at = now() - ($2 || ' minutes')::interval, predictions_close_at = now() - ($2 || ' minutes')::interval WHERE id=$1`, [id, String(minutesAgo)]);
}

test("only agents an Admin enabled can manage contests", async () => {
  const r = await call("GET", "/agent/football/contests", agentOffTok);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "FOOTBALL_NOT_ENABLED");
  assert.equal((await call("GET", "/agent/football/contests", ahmedTok)).status, 403, "customers can't use agent routes");
  assert.equal((await call("GET", "/agent/football/me", agentOffTok)).body.enabled, false);
  // Admin switches it on, then off again.
  assert.equal((await call("PUT", `/admin/football/agents/${AGENT_OFF}`, adminTok, { enabled: true })).status, 200);
  assert.equal((await call("GET", "/agent/football/contests", agentOffTok)).status, 200);
  await call("PUT", `/admin/football/agents/${AGENT_OFF}`, adminTok, { enabled: false });
  assert.equal((await call("GET", "/agent/football/contests", agentOffTok)).status, 403);
});

test("creating a contest: validation, team reuse, image upload", async () => {
  assert.equal((await call("POST", "/agent/football/contests", agentTok, { homeTeam: { name: "A FC" }, awayTeam: { name: "B FC" }, league: "X", kickoffAt: inHours(-1), rewardLabel: "1 GB", rewardCompanyId: "hormuud" })).status, 400, "kickoff in the past");
  assert.equal((await call("POST", "/agent/football/contests", agentTok, { homeTeam: { name: "A FC" }, awayTeam: { name: "a fc" }, league: "X", kickoffAt: inHours(2), rewardLabel: "1 GB", rewardCompanyId: "hormuud" })).status, 400, "same team twice");
  assert.equal((await call("POST", "/agent/football/contests", agentTok, { homeTeam: { name: "A FC" }, awayTeam: { name: "B FC" }, league: "X", kickoffAt: inHours(2), rewardLabel: "1 GB", rewardCompanyId: "nope" })).status, 400, "unknown provider");

  const bad = await call("POST", "/agent/football/images", agentTok, { imageBase64: "data:image/png;base64," + Buffer.from("not an image").toString("base64") });
  assert.equal(bad.status, 400, "content is checked, not the declared type");
  const img = await call("POST", "/agent/football/images", agentTok, { imageBase64: PNG, purpose: "contest_image" });
  assert.equal(img.status, 201);
  const logo = await call("POST", "/agent/football/images", agentTok, { imageBase64: PNG, purpose: "team_logo" });

  const c = await createContest({ imageId: img.body.id, homeTeam: { name: "Real Madrid", logoImageId: logo.body.id } });
  assert.equal(c.status, "open");
  assert.equal(c.displayStatus, "predictions_open");
  assert.equal(c.homeTeam.logoUrl, `/football/images/${logo.body.id}`);
  const served = await fetch(base + c.imageUrl);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  const again = await createContest();
  assert.equal(again.homeTeam.id, c.homeTeam.id, "teams are reused by name");

  // The image a contest uses can't be deleted.
  assert.equal((await call("DELETE", `/agent/football/images/${img.body.id}`, agentTok)).status, 409);
});

test("full contest: predictions, deadline, earliest exact score wins, agent confirms, notification, reward", async () => {
  const c = await createContest();
  const id = c.id;
  // Ahmed 2-3 first, then Sahra 2-3, then Yusuf 1-1 (the spec's example).
  assert.equal((await call("POST", `/football/contests/${id}/predictions`, ahmedTok, { homeGoals: 2, awayGoals: 3 })).status, 201);
  assert.equal((await call("POST", `/football/contests/${id}/predictions`, sahraTok, { homeGoals: 2, awayGoals: 3 })).status, 201);
  assert.equal((await call("POST", `/football/contests/${id}/predictions`, yusufTok, { homeGoals: 1, awayGoals: 1 })).status, 201);

  const dup = await call("POST", `/football/contests/${id}/predictions`, ahmedTok, { homeGoals: 0, awayGoals: 0 });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "ALREADY_PREDICTED");
  assert.equal((await call("POST", `/football/contests/${id}/predictions`, ahmedTok, { homeGoals: -1, awayGoals: 3 })).status, 400);
  assert.equal((await call("POST", `/football/contests/${id}/predictions`, ahmedTok, { homeGoals: 2.5, awayGoals: 3 })).status, 400);
  // The client can't choose its own time: an extra field is ignored.
  const ahmedPred = await queryOne<any>(`SELECT id, created_at FROM football_predictions WHERE contest_id=$1 AND customer_id=$2`, [id, AHMED]);
  await assert.rejects(query(`UPDATE football_predictions SET created_at = now() - interval '1 day' WHERE id=$1`, [ahmedPred.id]), /cannot be changed/);
  await assert.rejects(query(`UPDATE football_predictions SET home_goals = 4 WHERE id=$1`, [ahmedPred.id]), /cannot be changed/);

  // Result can't be entered before kickoff.
  assert.equal((await call("POST", `/agent/football/contests/${id}/result`, agentTok, { homeGoals: 2, awayGoals: 3 })).status, 409);

  // Deadline passes -> lifecycle closes it; late predictions rejected.
  await kickoffPassed(id, 5);
  const late = await call("POST", `/football/contests/${id}/predictions`, signAccessToken(randomUUID(), "customer"), { homeGoals: 2, awayGoals: 3 });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, "PREDICTIONS_CLOSED", "closed by the deadline even before the job runs");
  await runFootballLifecycle();
  assert.equal((await queryOne<any>(`SELECT status FROM football_contests WHERE id=$1`, [id])).status, "closed");
  await runFootballLifecycle(); // idempotent
  await kickoffPassed(id, 120);
  await runFootballLifecycle();
  assert.equal((await queryOne<any>(`SELECT status FROM football_contests WHERE id=$1`, [id])).status, "awaiting_result");

  // Official result 2-3.
  const res = await call("POST", `/agent/football/contests/${id}/result`, agentTok, { homeGoals: 2, awayGoals: 3 });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "verification");
  assert.equal(res.body.candidatePredictionId, ahmedPred.id, "Ahmed predicted 2-3 first");

  // Nobody is told they won yet.
  assert.equal(Number((await queryOne<any>(`SELECT COUNT(*) AS n FROM notifications WHERE type='football_contest'`)).n), 0);
  const ahmedView = await call("GET", `/football/contests/${id}`, ahmedTok);
  assert.equal(ahmedView.body.myResult, "pending");
  assert.equal(ahmedView.body.displayStatus, "winner_verification");

  // Search for 2-3: two predictions, earliest first, masked phones.
  const s = await call("GET", `/agent/football/contests/${id}/predictions?home=2&away=3`, agentTok);
  assert.equal(s.status, 200);
  assert.equal(s.body.total, 2);
  assert.deepEqual(s.body.items.map((i: any) => i.customerName), ["Ahmed Ali", "Sahra Maxamed"]);
  assert.equal(s.body.items[0].isCandidate, true);
  assert.equal(s.body.items[0].matchesOfficial, true);
  assert.equal(s.body.items[0].phoneMasked, "61****456");
  assert.ok(!JSON.stringify(s.body).includes("610123456"), "full phone numbers are not in search results");
  const all = await call("GET", `/agent/football/contests/${id}/predictions`, agentTok);
  assert.equal(all.body.total, 3);
  assert.equal(all.body.items[2].matchesOfficial, false);
  assert.equal((await call("GET", `/agent/football/contests/${id}/predictions?home=2`, agentTok)).status, 400);

  // The agent can't pick someone else.
  const sahraPred = s.body.items[1].predictionId;
  const wrong = await call("POST", `/agent/football/contests/${id}/confirm-winner`, agentTok, { predictionId: sahraPred });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, "NOT_THE_CANDIDATE");

  // Confirm Ahmed -> notification to Ahmed only, once.
  const ok = await call("POST", `/agent/football/contests/${id}/confirm-winner`, agentTok, { predictionId: ahmedPred.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "completed");
  const again = await call("POST", `/agent/football/contests/${id}/confirm-winner`, agentTok, { predictionId: ahmedPred.id });
  assert.equal(again.body.alreadyConfirmed, true);
  await runFootballLifecycle();
  const notes = await query<any>(`SELECT customer_id, title, body, data FROM notifications WHERE type='football_contest'`);
  assert.equal(notes.length, 1, "exactly one winner notification");
  assert.equal(notes[0].customer_id, AHMED);
  assert.equal(notes[0].title, "Hambalyo! Waad guuleysatay!");
  assert.match(notes[0].body, /Real Madrid vs Barcelona \(2 - 3\)/);
  assert.match(notes[0].body, /1 GB Internet/);
  assert.equal(notes[0].data.contestId, id);

  assert.equal((await call("GET", `/football/contests/${id}`, ahmedTok)).body.myResult, "won");
  const sahraView = await call("GET", `/football/contests/${id}`, sahraTok);
  assert.equal(sahraView.body.myResult, "lost");
  assert.equal(sahraView.body.winner.name, "Ahmed A.", "others see only a short public name");
  assert.ok(!JSON.stringify(sahraView.body).includes("610123456"));

  // A completed contest can't be re-scored or cancelled by an agent.
  assert.equal((await call("POST", `/agent/football/contests/${id}/result`, agentTok, { homeGoals: 1, awayGoals: 1 })).status, 409);
  assert.equal((await call("POST", `/agent/football/contests/${id}/cancel`, agentTok, { reason: "x" })).status, 409);

  // Reward: pending -> failed -> paid (retry) -> a second paid is refused.
  assert.equal((await call("POST", `/agent/football/contests/${id}/reward`, agentTok, { status: "pending" })).body.winnerStatus, "reward_pending");
  assert.equal((await call("POST", `/agent/football/contests/${id}/reward`, agentTok, { status: "paid" })).status, 400, "paid needs a transaction ref");
  const failed = await call("POST", `/agent/football/contests/${id}/reward`, agentTok, { status: "failed", note: "SIM out of balance" });
  assert.equal(failed.body.winnerStatus, "reward_failed");
  const paid = await call("POST", `/agent/football/contests/${id}/reward`, agentTok, { status: "paid", transactionRef: "MP2510201234" });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.attemptNo, 2);
  const twice = await call("POST", `/agent/football/contests/${id}/reward`, agentTok, { status: "paid", transactionRef: "MP2510209999" });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, "ALREADY_PAID");
  assert.equal(Number((await queryOne<any>(`SELECT COUNT(*) AS n FROM football_reward_transactions WHERE contest_id=$1 AND status='paid'`, [id])).n), 1);
  const detail = await call("GET", `/agent/football/contests/${id}`, agentTok);
  assert.equal(detail.body.winner.status, "reward_paid");
  assert.equal(detail.body.winner.phone, "252610123456", "the agent sees the confirmed winner's number to deliver the reward");
  assert.equal(detail.body.rewards.length, 2);
  assert.ok(detail.body.events.some((e: any) => e.action === "winner_confirmed"));
  assert.equal((await call("GET", `/football/contests/${id}`, ahmedTok)).body.myRewardStatus, "reward_paid");

  // Raadi Macmiil: by phone and by prediction id.
  const byPhone = await call("GET", `/agent/football/customers/search?q=0610123456`, agentTok);
  assert.equal(byPhone.status, 200);
  assert.equal(byPhone.body.customer.phoneMasked, "61****456");
  const p = byPhone.body.predictions.find((x: any) => x.contestId === id);
  assert.equal(p.outcome, "won");
  assert.equal(p.rewardStatus, "reward_paid");
  const byPred = await call("GET", `/agent/football/customers/search?q=${sahraPred}`, agentTok);
  assert.equal(byPred.body.customer.name, "Sahra Maxamed");
  assert.equal(byPred.body.predictions.find((x: any) => x.contestId === id).outcome, "correct_not_first");
  assert.equal((await call("GET", `/agent/football/customers/search?q=0619999999`, agentTok)).status, 404);
  assert.equal((await call("GET", `/agent/football/customers/search?q=0610123456`, agentOffTok)).status, 403);
});

test("no exact score means no winner; a result can be corrected before confirmation", async () => {
  const c = await createContest();
  await call("POST", `/football/contests/${c.id}/predictions`, ahmedTok, { homeGoals: 1, awayGoals: 0 });
  await call("POST", `/football/contests/${c.id}/predictions`, sahraTok, { homeGoals: 0, awayGoals: 0 });
  await kickoffPassed(c.id);
  const r = await call("POST", `/agent/football/contests/${c.id}/result`, agentTok, { homeGoals: 3, awayGoals: 3 });
  assert.equal(r.body.status, "no_winner");
  assert.equal(r.body.candidatePredictionId, null, "nobody with a wrong score is picked");
  assert.equal((await call("GET", `/football/contests/${c.id}`, ahmedTok)).body.myResult, "lost");
  // The score was mistyped: correct it -> Sahra (0-0) becomes the candidate.
  const fix = await call("POST", `/agent/football/contests/${c.id}/result`, agentTok, { homeGoals: 0, awayGoals: 0 });
  assert.equal(fix.body.status, "verification");
  const ev = await query<any>(`SELECT action FROM football_contest_events WHERE contest_id=$1 ORDER BY created_at`, [c.id]);
  assert.ok(ev.some((e) => e.action === "result_corrected"), "corrections are audited");
});

test("disputes pause rewards; an Admin corrects the result and the old winner is kept as revoked", async () => {
  const c = await createContest();
  await call("POST", `/football/contests/${c.id}/predictions`, ahmedTok, { homeGoals: 1, awayGoals: 1 });
  await call("POST", `/football/contests/${c.id}/predictions`, yusufTok, { homeGoals: 2, awayGoals: 1 });
  await kickoffPassed(c.id);
  const r = await call("POST", `/agent/football/contests/${c.id}/result`, agentTok, { homeGoals: 1, awayGoals: 1 });
  await call("POST", `/agent/football/contests/${c.id}/confirm-winner`, agentTok, { predictionId: r.body.candidatePredictionId });

  assert.equal((await call("POST", `/agent/football/contests/${c.id}/dispute`, agentTok, { reason: "" })).status, 400);
  assert.equal((await call("POST", `/agent/football/contests/${c.id}/dispute`, agentTok, { reason: "Official score was 2-1" })).body.status, "disputed");
  assert.equal((await call("POST", `/agent/football/contests/${c.id}/reward`, agentTok, { status: "paid", transactionRef: "X1" })).status, 409, "no reward while disputed");
  assert.equal((await call("GET", `/football/contests/${c.id}`, ahmedTok)).body.myResult, "pending", "a disputed win isn't shown as won");

  const fix = await call("POST", `/admin/football/contests/${c.id}/resolve`, adminTok, { action: "correct_result", homeGoals: 2, awayGoals: 1, note: "League site says 2-1" });
  assert.equal(fix.status, 200);
  assert.equal(fix.body.status, "verification");
  const w = await query<any>(`SELECT customer_id, status FROM football_winners WHERE contest_id=$1 ORDER BY confirmed_at`, [c.id]);
  assert.equal(w.length, 1);
  assert.equal(w[0].status, "revoked", "the overturned winner is kept, not deleted");
  const yusufPred = await queryOne<any>(`SELECT id FROM football_predictions WHERE contest_id=$1 AND customer_id=$2`, [c.id, YUSUF]);
  assert.equal(fix.body.candidatePredictionId, yusufPred.id);
  assert.equal((await call("POST", `/agent/football/contests/${c.id}/confirm-winner`, agentTok, { predictionId: yusufPred.id })).status, 200);
  await runFootballLifecycle();
  assert.equal(Number((await queryOne<any>(`SELECT COUNT(*) AS n FROM notifications WHERE type='football_contest' AND customer_id=$1`, [YUSUF])).n), 1);

  // Once a reward is paid, the result can't be changed; uphold only.
  await call("POST", `/agent/football/contests/${c.id}/reward`, agentTok, { status: "paid", transactionRef: "MP1" });
  await call("POST", `/admin/football/contests/${c.id}/dispute`, adminTok, { reason: "Customer complaint" });
  assert.equal((await call("POST", `/admin/football/contests/${c.id}/resolve`, adminTok, { action: "correct_result", homeGoals: 0, awayGoals: 0 })).status, 409);
  const up = await call("POST", `/admin/football/contests/${c.id}/resolve`, adminTok, { action: "uphold" });
  assert.equal(up.body.status, "completed");
  assert.equal((await queryOne<any>(`SELECT status FROM football_winners WHERE contest_id=$1 AND status<>'revoked'`, [c.id])).status, "reward_paid");
});

test("postponed and cancelled matches", async () => {
  const c = await createContest();
  await call("POST", `/football/contests/${c.id}/predictions`, ahmedTok, { homeGoals: 1, awayGoals: 2 });
  await kickoffPassed(c.id, 1);
  await runFootballLifecycle();
  const p = await call("POST", `/agent/football/contests/${c.id}/postpone`, agentTok, { kickoffAt: inHours(48), reason: "Weather" });
  assert.equal(p.body.status, "open", "predictions reopen until the new kickoff");
  assert.equal(Number((await queryOne<any>(`SELECT COUNT(*) AS n FROM football_predictions WHERE contest_id=$1`, [c.id])).n), 1, "existing predictions kept");
  assert.equal((await call("POST", `/football/contests/${c.id}/predictions`, sahraTok, { homeGoals: 0, awayGoals: 0 })).status, 201);
  assert.equal((await call("POST", `/agent/football/contests/${c.id}/cancel`, agentTok, { reason: "" })).status, 400);
  assert.equal((await call("POST", `/agent/football/contests/${c.id}/cancel`, agentTok, { reason: "Match abandoned" })).body.status, "cancelled");
  assert.equal((await call("POST", `/football/contests/${c.id}/predictions`, yusufTok, { homeGoals: 0, awayGoals: 0 })).status, 409);
  const list = await call("GET", `/football/contests?scope=completed`, ahmedTok);
  assert.ok(list.body.some((x: any) => x.id === c.id && x.displayStatus === "cancelled"));
});

test("drafts are hidden from customers until published", async () => {
  const c = await createContest({ publish: false });
  assert.equal(c.status, "draft");
  assert.equal((await call("GET", `/football/contests/${c.id}`, ahmedTok)).status, 404);
  assert.equal((await call("POST", `/football/contests/${c.id}/predictions`, ahmedTok, { homeGoals: 1, awayGoals: 1 })).status, 404);
  assert.equal((await call("POST", `/agent/football/contests/${c.id}/publish`, agentTok)).body.status, "open");
  const list = await call("GET", `/football/contests`, ahmedTok);
  assert.ok(list.body.some((x: any) => x.id === c.id));
});

test("cleanup deletes only unused images and never prediction or reward records", async () => {
  const keep = await call("POST", "/agent/football/images", agentTok, { imageBase64: PNG });
  const c = await createContest({ imageId: keep.body.id });
  const unused = await call("POST", "/agent/football/images", agentTok, { imageBase64: PNG });
  const del = await call("DELETE", `/agent/football/images/${unused.body.id}`, agentTok);
  assert.equal(del.body.status, "pending_deletion");
  const unusedRow = await queryOne<any>(`SELECT storage_key FROM media_images WHERE id=$1`, [unused.body.id]);
  // An orphan file on disk with no database row, older than a day.
  const orphan = path.join(MEDIA, "2000-01", "orphan.png");
  await fs.mkdir(path.dirname(orphan), { recursive: true });
  await fs.writeFile(orphan, "x");
  const old = new Date(Date.now() - 3 * 24 * 3600_000);
  await fs.utimes(orphan, old, old);

  const counts = async () => (await queryOne<any>(`SELECT (SELECT COUNT(*) FROM football_predictions) p, (SELECT COUNT(*) FROM football_winners) w, (SELECT COUNT(*) FROM football_reward_transactions) t, (SELECT COUNT(*) FROM football_contest_events) e`));
  const before = await counts();
  const r = await runMediaCleanup();
  assert.ok(r.deleted >= 2, JSON.stringify(r));
  assert.equal((await queryOne<any>(`SELECT status FROM media_images WHERE id=$1`, [unused.body.id])).status, "deleted");
  await assert.rejects(fs.stat(path.join(MEDIA, unusedRow.storage_key)));
  await assert.rejects(fs.stat(orphan));
  assert.equal((await queryOne<any>(`SELECT status FROM media_images WHERE id=$1`, [keep.body.id])).status, "active", "the image a contest uses stays");
  assert.equal((await fetch(base + `/football/images/${keep.body.id}`)).status, 200);
  assert.equal((await fetch(base + `/football/images/${unused.body.id}`)).status, 404);
  assert.deepEqual(await counts(), before, "no predictions, winners, rewards or audit events removed");
  assert.ok(await queryOne(`SELECT 1 FROM cleanup_runs WHERE job='media_cleanup' AND finished_at IS NOT NULL`), "each run is logged");
  void c;
});

test("helpers: phone masking and public names", () => {
  assert.equal(maskPhone("252610123456"), "61****456");
  assert.equal(maskPhone(null), "");
  assert.equal(publicName("Ahmed Ali Yusuf"), "Ahmed A.");
  assert.equal(publicName("Sahra"), "Sahra");
});

test("admin overview lists contests with winners and the reward ledger", async () => {
  const list = await call("GET", "/admin/football/contests", adminTok);
  assert.equal(list.status, 200);
  assert.ok(list.body.length >= 4);
  assert.ok(list.body.some((c: any) => c.winner && c.winner.phoneMasked === "61****456"));
  const rewards = await call("GET", "/admin/football/rewards", adminTok);
  assert.ok(rewards.body.some((t: any) => t.status === "paid" && t.recipientPhoneMasked));
  assert.equal((await call("GET", "/admin/football/contests", agentTok)).status, 403);
  assert.equal((await call("GET", "/admin/football/cleanup-runs", adminTok)).status, 200);
});
