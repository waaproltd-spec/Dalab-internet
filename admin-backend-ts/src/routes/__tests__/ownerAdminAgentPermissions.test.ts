// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/routes/__tests__/ownerAdminAgentPermissions.test.ts
//
// Owner / Admin / Agent, through the real server (every middleware and
// route, as in production):
//  - OWNER (super_admin): everything; the only one who grants or revokes an
//    Admin's permissions or an Agent's services.
//  - ADMIN: only the sections granted -- reading too; with agents.manage
//    manages agents but never their services; never the Owner.
//  - AGENT: only the services granted; the phone's automatic work is never
//    blocked; no admin functions.
// A revoke applies on the next request (same token), and every grant and
// revoke is in the audit with who, whom, what and when.
process.env.PORT = "0";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { query, queryOne, pool } from "../../db/pool.js";
import { signAccessToken } from "../../auth/crypto.js";
import app from "../../server.js";
import { applyHubEntry } from "../hub.routes.js";

const OWNER = randomUUID();
const ADMIN = randomUUID();
const AGENT = randomUUID();
const OWNER_EMAIL = `owner-${OWNER.slice(0, 8)}@example.com`;
const ADMIN_EMAIL = `admin-${ADMIN.slice(0, 8)}@example.com`;
const owner = signAccessToken(OWNER, "super_admin");
const admin = signAccessToken(ADMIN, "admin");
const agent = signAccessToken(AGENT, "agent");
const INSTALL = `perm-install-${AGENT.slice(0, 8)}`;
let server: Server;
let base: string;

function call(token: string, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    // The agent's phone is an activated device, as in production.
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "x-agent-install-id": INSTALL },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as any }));
}
const audit = (targetId: string) =>
  query<any>(`SELECT * FROM permission_audit WHERE target_id=$1 ORDER BY created_at, id`, [targetId]);

before(async () => {
  await query(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1,$2,'x','super_admin')`, [OWNER, OWNER_EMAIL]);
  await query(`INSERT INTO admin_users (id, email, password_hash, role, permissions) VALUES ($1,$2,'x','admin',$3)`, [
    ADMIN, ADMIN_EMAIL, ["orders.manage", "agents.manage"],
  ]);
  await query(`INSERT INTO agents (id, phone, name, password_hash, services) VALUES ($1,'252699000901','Perm Agent','x',$2)`, [AGENT, ["customers"]]);
  await query(`INSERT INTO agent_device_activations (agent_id, install_id, device_number, status) VALUES ($1,$2,$3,'approved')`, [AGENT, INSTALL, `P-${AGENT.slice(0, 6)}`]);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

// ---------------- Admin ----------------

test("ADMIN opens only the sections the Owner granted -- reading included", async () => {
  assert.equal((await call(admin, "GET", "/admin/orders")).status, 200);
  assert.equal((await call(admin, "GET", "/admin/agents")).status, 200);
  for (const p of ["/admin/customers", "/admin/finance/overview", "/admin/reports", "/admin/sms-logs", "/admin/exchange/orders", "/admin/commissions"]) {
    const r = await call(admin, "GET", p);
    assert.equal(r.status, 403, p);
    assert.equal(r.body.code, "permission_required", p);
  }
  // Shared lookups every page needs stay readable.
  assert.equal((await call(admin, "GET", "/admin/companies")).status, 200);
});

test("ADMIN never manages the Owner, other admins, or its own permissions", async () => {
  assert.equal((await call(admin, "GET", "/admin/users")).status, 403);
  assert.equal((await call(admin, "PUT", `/admin/users/${ADMIN}/permissions`, { permissions: ["finance.manage"] })).status, 403);
  assert.equal((await call(admin, "PUT", `/admin/users/${ADMIN}/role`, { role: "super_admin" })).status, 403);
  assert.equal((await call(admin, "DELETE", `/admin/users/${OWNER}`)).status, 403);
  assert.equal((await call(admin, "GET", "/admin/permission-audit")).status, 403);
  const me = await queryOne<any>(`SELECT role, permissions FROM admin_users WHERE id=$1`, [ADMIN]);
  assert.deepEqual([me.role, me.permissions], ["admin", ["orders.manage", "agents.manage"]]);
});

test("ADMIN with agents.manage manages agents but has no say over an agent's services", async () => {
  assert.equal((await call(admin, "PUT", `/admin/agents/${AGENT}`, { name: "Perm Agent" })).status, 200);
  assert.equal((await call(admin, "PUT", `/admin/agents/${AGENT}/services`, { services: ["customers", "reports"] })).status, 403);
  assert.equal((await call(admin, "PUT", `/admin/agents/${AGENT}/operations`, { enabled: true })).status, 403);
  assert.equal((await call(admin, "PUT", `/admin/football/agents/${AGENT}`, { enabled: true })).status, 403);
  assert.equal((await call(admin, "GET", "/admin/agent-services")).status, 403);
  const a = await queryOne<any>(`SELECT services, operations_enabled, ciyaaraha_enabled FROM agents WHERE id=$1`, [AGENT]);
  assert.deepEqual([a.services, a.ciyaaraha_enabled], [["customers"], false]);
});

// ---------------- Agent ----------------

test("AGENT uses only the services granted; the phone's automatic work is never blocked", async () => {
  const cu = await call(agent, "GET", "/agent/customers");
  assert.equal(cu.status, 200, JSON.stringify(cu.body));
  for (const [m, p] of [["GET", "/agent/reports"], ["GET", "/agent/scheduled-orders"], ["GET", "/agent/registered-customers"], ["POST", "/agent/orders/DLB000000000/cancel"], ["GET", "/agent/agents"], ["GET", "/agent/football/contests"]] as const) {
    const r = await call(agent, m, p, m === "POST" ? { reason: "test" } : undefined);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.body.code, "service_not_allowed", `${m} ${p}`);
  }
  // Automatic work and basics: not services.
  assert.equal((await call(agent, "GET", "/agent/sms-formats")).status, 200);
  assert.equal((await call(agent, "GET", "/agent/orders")).status, 200);
  assert.equal((await call(agent, "GET", "/agent/football/me")).body.enabled, false);
  const me = await call(agent, "GET", "/agent/me/services");
  assert.deepEqual(me.body.services, ["customers"]);
});

test("AGENT has no admin functions at all", async () => {
  for (const p of ["/admin/agents", "/admin/orders", "/admin/users", "/admin/permission-audit", "/admin/agent-services"]) {
    assert.equal((await call(agent, "GET", p)).status, 403, p);
  }
  assert.equal((await call(agent, "PUT", `/admin/agents/${AGENT}/services`, { services: ["reports"] })).status, 403);
});

// ---------------- Owner ----------------

test("OWNER sees and manages everything", async () => {
  for (const p of ["/admin/customers", "/admin/finance/overview", "/admin/orders", "/admin/users", "/admin/agent-services", "/admin/permission-catalog"]) {
    assert.equal((await call(owner, "GET", p)).status, 200, p);
  }
  const cat = (await call(owner, "GET", "/admin/permission-catalog")).body;
  assert.ok(cat.agentServices.some((s: any) => s.key === "operations"));
  assert.ok(cat.adminPermissions.includes("orders.manage"));
});

test("OWNER grants and revokes an agent's services: applies on the next request, and is audited", async () => {
  let r = await call(owner, "PUT", `/admin/agents/${AGENT}/services`, { services: ["customers", "reports"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call(agent, "GET", "/agent/reports")).status, 200, "granted: allowed at once");
  r = await call(owner, "PUT", `/admin/agents/${AGENT}/services`, { services: ["reports"] });
  assert.equal(r.status, 200);
  assert.equal((await call(agent, "GET", "/agent/customers")).status, 403, "revoked: blocked at once, same token");
  assert.equal((await call(owner, "PUT", `/admin/agents/${AGENT}/services`, { services: ["reports", "not_a_service"] })).status, 400);

  // The older Operations switch is the same "operations" service.
  assert.equal((await call(owner, "PUT", `/admin/agents/${AGENT}/operations`, { enabled: true })).status, 200);
  const a = await queryOne<any>(`SELECT services, operations_enabled FROM agents WHERE id=$1`, [AGENT]);
  assert.deepEqual([a.services, a.operations_enabled], [["operations", "reports"], true]);

  const rows = await audit(AGENT);
  assert.deepEqual(rows.map((x) => [x.granted, x.revoked]), [[["reports"], []], [[], ["customers"]], [["operations"], []]]);
  assert.ok(rows.every((x) => x.actor_id === OWNER && x.actor_label === OWNER_EMAIL && x.target_type === "agent" && x.source === "dashboard"));
  assert.equal(rows[0].target_label, "Perm Agent (252699000901)");
  const listed = (await call(owner, "GET", `/admin/permission-audit?targetType=agent&targetId=${AGENT}`)).body;
  assert.equal(listed.length, 3);
});

test("OWNER revokes an Admin permission: blocked on the next request, same token; audited", async () => {
  assert.equal((await call(admin, "GET", "/admin/orders")).status, 200);
  const r = await call(owner, "PUT", `/admin/users/${ADMIN}/permissions`, { permissions: ["agents.manage", "customers.manage"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call(admin, "GET", "/admin/orders")).status, 403, "revoked");
  assert.equal((await call(admin, "GET", "/admin/customers")).status, 200, "granted");
  const rows = await audit(ADMIN);
  const last = rows[rows.length - 1];
  assert.deepEqual([last.granted, last.revoked, last.actor_label, last.target_label], [["customers.manage"], ["orders.manage"], OWNER_EMAIL, ADMIN_EMAIL]);

  assert.equal((await call(owner, "PUT", `/admin/users/${ADMIN}/role`, { role: "super_admin" })).status, 200);
  assert.equal((await call(owner, "PUT", `/admin/users/${ADMIN}/role`, { role: "admin" })).status, 200);
  const roles = (await audit(ADMIN)).filter((x) => x.role_after);
  assert.deepEqual(roles.map((x) => [x.role_before, x.role_after]), [["admin", "super_admin"], ["super_admin", "admin"]]);
});

test("Admin Hub changes to an Admin's permissions are audited too", async () => {
  const hubUserId = randomUUID();
  const email = `hub-${hubUserId.slice(0, 8)}@example.com`;
  const created = await applyHubEntry({ hubUserId, email, role: "admin", permissions: ["orders.manage"] }, true);
  assert.ok(created);
  await applyHubEntry({ hubUserId, email, role: "admin", permissions: ["finance.manage"] }, false);
  await applyHubEntry({ hubUserId, email, role: "admin", permissions: ["finance.manage"] }, false); // no change: no row
  await applyHubEntry({ hubUserId, email, role: null, disabled: true }, false);
  const rows = await audit(created!.id);
  assert.deepEqual(
    rows.map((x) => [x.source, x.actor_label, x.granted, x.revoked, x.role_after]),
    [
      ["admin_hub", "Admin Hub", ["orders.manage"], [], "admin"],
      ["admin_hub", "Admin Hub", ["finance.manage"], ["orders.manage"], null],
      ["admin_hub", "Admin Hub", [], ["finance.manage"], "disabled"],
    ]
  );
});

test("a new agent starts with no services until the Owner grants them", async () => {
  const r = await call(owner, "POST", "/admin/agents", { phone: "252699000902", name: "New Agent", password: "Pass1234!" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = await queryOne<any>(`SELECT services, operations_enabled FROM agents WHERE id=$1`, [r.body.id]);
  assert.deepEqual([a.services, a.operations_enabled], [[], false]);
});
