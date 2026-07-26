# DALAB INTERNET — Backend API

A real, running, tested Node.js backend for the DALAB INTERNET system — not a mock,
not a plan. It implements every endpoint in `dalab-backend-architecture.md` and is
what the Customer App, Agent App, and Super Admin Dashboard are all meant to share.

## Why no Express / Postgres / npm packages

This was built inside a sandboxed environment with **no network access** — the npm
registry isn't reachable, so nothing could be `npm install`ed. Instead this uses
only what's built into Node 22:

- **`node:sqlite`** instead of `pg` + Postgres — a real embedded database, not a
  mock. The schema (`src/db/schema.sql`) is written to map 1:1 onto the Postgres
  schema already documented in the architecture doc; moving to Postgres later is
  mostly a driver swap (see "Moving to Postgres" below), not a redesign.
- **A ~100-line router on `node:http`** instead of Express (`src/http/router.js`)
  — same request/response shape, so swapping in real Express is mechanical.
- **`node:crypto`** (scrypt + HMAC-SHA256) instead of `bcrypt` + `jsonwebtoken` —
  hand-rolled but standard, well-understood primitives, not something exotic.
- **`node:test`** instead of Jest — Node's built-in test runner.

None of this is a downgrade in what's *proven* — it's a real database with real
constraints, a real auth flow, and a real test suite. It's a downgrade only in
familiarity of the tooling names.

## Running it

```bash
npm start          # starts on http://localhost:4000
npm test           # runs the full test suite (node --test)
```

On first run it seeds:
- 4 companies (Hormuud, Somnet, Somtel, Amtel — Amtel starts offline) with their
  real package pricing from the customer app prototype
- One demo admin: `admin@dalabinternet.so` / `ChangeMe123!`
- One demo agent: `252610000001` / `AgentPass123!`

**Change both of those before this ever goes anywhere near production.**

## Verified working (not just written — actually run)

Every one of these was tested with real `curl` calls against the running server,
not assumed from reading the code:

- Customer OTP login → JWT issued → order placed against real seeded package data
- Agent login → sees the pending order → uploads a simulated payment SMS →
  **server-side matching** finds the right order by company + amount → agent
  verifies → completes → Macaash points credited to the *right* customer
- **RBAC enforcement**: a customer's JWT hitting `/agent/orders` gets a real 403,
  not just documentation saying it should
- Admin login → dashboard stats reflect the actual completed order
- Refresh token rotation: reusing an already-rotated refresh token is rejected

`npm test` runs 12 end-to-end tests covering all of the above plus edge cases
(wrong OTP, ordering against an offline company, double-verifying a completed
order, unauthenticated requests). All 12 pass, consistently, across repeated runs.

### A real bug that got caught and fixed along the way

Worth stating plainly rather than hiding: an earlier version of `src/db/index.js`
computed the database file path as a **module-level `const`** evaluated at import
time — before `buildServer()` ever got a chance to override it with a test-specific
path. Every "isolated" test run was silently sharing one leftover database file,
which surfaced as a Macaash balance test failing intermittently with wrong point
totals. Root cause: JS module evaluation order, not test flakiness. Fixed by
resolving the path lazily inside `openDb()` instead. Left in this README because
future-me (or whoever inherits this) should know it happened and why.

## What's real vs. what's still a gap

**Real:** every route, the database, the auth flow, RBAC, the test suite, the SMS
matching logic, the Macaash ledger, all of it runs and is verified.

**Still a gap — and this is the important one:** this server only runs inside this
sandbox. It has no public URL. The Customer App and Admin Dashboard prototypes
render in a completely separate, isolated browser preview with no network path to
this machine. So even though this backend is real and tested, **it is not currently
reachable by those two frontends** — connecting them requires actually deploying
this (Render, Fly.io, a VPS, anything reachable over HTTPS) and pointing the
frontends' API base URL at it. That deployment step is outside what's possible
from within this chat.

## Moving to Postgres for real production use

1. Swap `node:sqlite`'s `DatabaseSync` for `pg` (or `postgres.js`) in `src/db/index.js`.
2. `schema.sql` needs: `TEXT` → `UUID`/`TIMESTAMPTZ` where noted in the file's
   header comment, `INTEGER 0/1` → `BOOLEAN`, `datetime('now', ...)` → `now() +
   interval '...'`, and `CREATE INDEX ... WHERE active = true` (partial index)
   works in Postgres as-is.
3. Every query elsewhere in `src/routes/*.js` is plain parameterized SQL (`?`
   placeholders) — `pg` uses `$1, $2, ...` instead, so each `db.prepare(...).run()`
   /`.get()`/`.all()` call needs its placeholder style updated, but the SQL logic
   itself doesn't change.
4. Swap `node:http`'s router for real Express if preferred — the `ctx` shape
   (`params`, `query`, `body`, `json()`) was deliberately kept close to what an
   Express `(req, res)` pair gives you.

## Endpoints

See `dalab-backend-architecture.md` §4 for the full list this implements — customer
auth/orders/Macaash, agent auth/orders/SMS-logs/transactions, admin
companies/packages/orders/customers/agents/banners/notifications/reports, plus
`GET /health`.
