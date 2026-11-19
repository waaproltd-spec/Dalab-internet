// Run against a real local Postgres test database:
//
//   DATABASE_URL=postgres://user:pass@127.0.0.1:5432/test PGSSL=false \
//     npx tsx --test src/routes/__tests__/hubAgentLogin.test.ts
//
// AGENT APP sign-in through the Admin Hub, system side: the hub's signed
// phone + PIN check, the phone-in-use check, and the single-use hand-off
// that starts this system's agent session.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import jwtLib from "jsonwebtoken";

const keys = generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const otherKeys = generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
process.env.HUB_PUBLIC_KEY = keys.publicKey;
process.env.HUB_SYSTEM_KEY = "dalab";

const { query, queryOne, pool } = await import("../../db/pool.js");
const { hashPassword, verifyToken, signAccessToken } = await import("../../auth/crypto.js");
const { agentsRouter } = await import("../agents.routes.js");
const { hubAgentsRouter } = await import("../hubAgents.routes.js");

const jwt = jwtLib as unknown as { sign: (p: object, k: string, o: Record<string, unknown>) => string };
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

function hubToken(typ: string, payload: Record<string, unknown>, opts: { aud?: string; key?: string; sub?: string } = {}) {
  return jwt.sign({ ...payload, typ }, opts.key ?? keys.privateKey, {
    algorithm: "ES256",
    issuer: "waaproltd-admin-hub",
    audience: opts.aud ?? "dalab",
    expiresIn: 60,
    jwtid: randomUUID(),
    ...(opts.sub ? { subject: opts.sub } : {}),
  });
}
const checkToken = (phone: string, pin: string, opts = {}) => hubToken("hub_agent_check", { bodyHash: sha256(`agent-check\n${phone}\n${pin}`) }, opts);

const app = express();
app.use(express.json());
app.use(hubAgentsRouter);
app.use(agentsRouter);
let server: http.Server;
let base: string;

async function post(path: string, body: unknown, token?: string, method = "POST") {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const AGENT = randomUUID();
const SUSPENDED = randomUUID();
const PLUS = randomUUID();

before(async () => {
  await query(`CREATE TABLE IF NOT EXISTS hub_used_tokens (jti TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL)`);
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'252615550101','Ali',$2)`, [AGENT, await hashPassword("4321")]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, status) VALUES ($1,'615550102','Off',$2,'suspended')`, [SUSPENDED, await hashPassword("1111")]);
  await query(`INSERT INTO agents (id, phone, name, password_hash) VALUES ($1,'+252 61 555 0103','Plus',$2)`, [PLUS, await hashPassword("pass-word9")]);
  server = http.createServer(app as unknown as http.RequestListener);
  server.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

test("the hub's check: the right PIN matches the agent, a wrong one doesn't, whatever spelling the number is stored in", async () => {
  const ok = await post("/admin/hub/agent-check", { phone: "615550101", pin: "4321" }, checkToken("615550101", "4321"));
  assert.deepEqual(ok.body, { match: true, agentId: AGENT });
  const wrong = await post("/admin/hub/agent-check", { phone: "615550101", pin: "0000" }, checkToken("615550101", "0000"));
  assert.deepEqual(wrong.body, { match: false });
  const plus = await post("/admin/hub/agent-check", { phone: "615550103", pin: "pass-word9" }, checkToken("615550103", "pass-word9"));
  assert.equal(plus.body.agentId, PLUS, "an existing password works as the PIN, and a '+252 ...' stored number is found");
  const nobody = await post("/admin/hub/agent-check", { phone: "615559999", pin: "4321" }, checkToken("615559999", "4321"));
  assert.deepEqual(nobody.body, { match: false }, "an unknown number gives the same answer as a wrong PIN");
  const suspended = await post("/admin/hub/agent-check", { phone: "615550102", pin: "1111" }, checkToken("615550102", "1111"));
  assert.deepEqual(suspended.body, { match: false }, "a suspended agent never matches");
});

test("only a fresh, correctly signed hub request bound to exactly this phone + PIN is answered", async () => {
  assert.equal((await post("/admin/hub/agent-check", { phone: "615550101", pin: "4321" })).status, 401, "no token");
  assert.equal((await post("/admin/hub/agent-check", { phone: "615550101", pin: "4321" }, checkToken("615550101", "4321", { key: otherKeys.privateKey }))).status, 401, "not the hub's key");
  assert.equal((await post("/admin/hub/agent-check", { phone: "615550101", pin: "4321" }, checkToken("615550101", "4321", { aud: "danwadaag" }))).status, 401, "addressed to another system");
  assert.equal((await post("/admin/hub/agent-check", { phone: "615550101", pin: "9999" }, checkToken("615550101", "4321"))).status, 401, "token for a different PIN");
  assert.equal((await post("/admin/hub/agent-check", { phone: "615550101", pin: "4321" }, hubToken("hub_agent_phone", {}))).status, 401, "wrong kind of message");
  const once = checkToken("615550101", "4321");
  assert.equal((await post("/admin/hub/agent-check", { phone: "615550101", pin: "4321" }, once)).status, 200);
  assert.equal((await post("/admin/hub/agent-check", { phone: "615550101", pin: "4321" }, once)).status, 401, "replayed");
});

test("phone-in-use answers yes/no for any spelling, only to the hub", async () => {
  const yes = await post("/admin/hub/agent-phone", { phone: "252615550101" }, hubToken("hub_agent_phone", { bodyHash: sha256("agent-phone\n615550101") }));
  assert.deepEqual(yes.body, { inUse: true });
  const no = await post("/admin/hub/agent-phone", { phone: "615559999" }, hubToken("hub_agent_phone", { bodyHash: sha256("agent-phone\n615559999") }));
  assert.deepEqual(no.body, { inUse: false });
  assert.equal((await post("/admin/hub/agent-phone", { phone: "615550101" })).status, 401);
});

test("the hub's pass starts this system's agent session once; expired, replayed or foreign passes and inactive agents are refused", async () => {
  const pass = hubToken("hub_agent_sso", {}, { sub: AGENT });
  const ok = await post("/agent/auth/hub-login", { handoff: pass });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.agent.id, AGENT);
  const claims = verifyToken(ok.body.accessToken);
  assert.equal(claims?.sub, AGENT);
  assert.equal(claims?.role, "agent");
  assert.ok((await queryOne<any>(`SELECT last_login_at FROM agents WHERE id=$1`, [AGENT])).last_login_at);
  assert.equal((await post("/agent/auth/hub-login", { handoff: pass })).status, 401, "a pass works once");
  assert.equal((await post("/agent/auth/hub-login", { handoff: hubToken("hub_agent_sso", {}, { sub: AGENT, aud: "danwadaag" }) })).status, 401, "another system's pass");
  assert.equal((await post("/agent/auth/hub-login", { handoff: hubToken("hub_agent_check", {}, { sub: AGENT }) })).status, 401, "not a sign-in pass");
  assert.equal((await post("/agent/auth/hub-login", { handoff: hubToken("hub_agent_sso", {}, { sub: SUSPENDED }) })).status, 403, "suspended agent");
});

test("an admin sets an agent's PIN (4-8 digits); the hub's check then accepts the new PIN only", async () => {
  const admin = signAccessToken(randomUUID(), "super_admin");
  const put = (id: string, pin: unknown, token?: string) => post(`/admin/agents/${id}/pin`, { pin }, token, "PUT");
  assert.equal((await put(AGENT, "1234")).status, 401, "signed-in staff only");
  assert.equal((await put(AGENT, "12", admin)).status, 400, "too short");
  assert.equal((await put(AGENT, "12a4", admin)).status, 400, "digits only");
  assert.equal((await put(randomUUID(), "1234", admin)).status, 404);
  assert.equal((await put(AGENT, "2580", admin)).status, 200);
  const ok = await post("/admin/hub/agent-check", { phone: "615550101", pin: "2580" }, checkToken("615550101", "2580"));
  assert.deepEqual(ok.body, { match: true, agentId: AGENT });
  const old = await post("/admin/hub/agent-check", { phone: "615550101", pin: "4321" }, checkToken("615550101", "4321"));
  assert.deepEqual(old.body, { match: false }, "the old PIN no longer works");
});
