# DALAB Admin Panel Backend — Node.js + Express + TypeScript + PostgreSQL

## Read this first — what's verified here, and how

This sandbox has **no network access**, so `npm install` cannot reach the
npm registry, and there's **no PostgreSQL server** available locally either.
That means, unlike the companion SQLite/plain-Node backend elsewhere in this
project (which was actually run — 43 passing automated tests against a live
server), this one could not be started or hit with a live request here.

What *is* real and actually checked:
- **Full TypeScript type-check passes with zero errors** — `tsc --noEmit`,
  verified by actually running it, not by inspection. The `typings/` folder
  contains hand-written ambient declarations for `express`/`pg`/
  `jsonwebtoken`/`bcryptjs`/Node builtins, written only because
  `@types/node` etc. can't be installed here. **Delete the whole `typings/`
  folder once you run `npm install` for real** — the actual packages ship
  complete, correct types that these stand-ins would otherwise shadow.
- Two real bugs were caught by actually re-running the type-check after
  each fix, not just written correctly on the first try:
  1. `tsconfig.json` initially *excluded* the `typings/` folder it needed to
     *include* — the stubs were silently never loaded.
  2. A stub file mixed `declare global` and `declare module "node:crypto"`
     in the same file, which — because the file had a top-level `export {}`
     — turned every `declare module` block into a no-op "augmentation" of a
     module that didn't exist, rather than a new ambient module. Split into
     two files once diagnosed.
- The business logic (order lifecycle, cross-network payment matching,
  Macaash crediting, RBAC boundaries) mirrors what's already proven correct
  and tested in the SQLite backend — same logic, translated to `pg`
  parameterized queries (`$1, $2...`) and Postgres syntax.

**"Production build succeeds" / "starts without errors on Render" can only
be fully confirmed once actually deployed** — Render has the real npm
registry and a real Postgres instance neither of which exist here. The setup
below is built to make that as likely as possible on the first try, but I'm
not going to claim a live-verified success I didn't actually observe.

## Backend consolidation (this pass)

Per project decision: **this Express + TypeScript + PostgreSQL backend is
now the sole production backend.** The earlier SQLite backend is
legacy/reference only — the Customer App, Agent App, and Admin Dashboard
should all point here and nowhere else.

To make that safe, I did a real route-by-route and field-by-field diff
between the two backends before touching any frontend code:
- **Route inventory diff**: every route in the SQLite backend exists here
  under the identical path and method — zero gaps. This backend additionally
  has the Settings and Admin user-management modules the SQLite one never had.
- **Response shape diff**: the `COMPANY_COLUMNS` list and `ORDER_LIST_SELECT`
  query (the two most-consumed shared shapes) are character-for-character
  identical between both backends' route files.
- **One real, if minor, difference found and fixed on the frontend side**:
  Postgres returns timestamp columns as full ISO 8601 strings (via a JS
  `Date` object serialized by `res.json()`) — e.g.
  `"2026-07-25T08:34:50.000Z"` — where the SQLite backend returned a plain
  `"2026-07-25 08:34:50"` string. Nothing broke (both parse fine, nothing
  crashed), but two admin-dashboard display sites and two native-Kotlin
  screens were showing the raw value unformatted. Added a shared date
  formatter on each client rather than changing the backend's timestamp
  type, since ISO 8601 is the more correct wire format to keep.

### Rate limiting (new)

Login and OTP endpoints had no brute-force protection. Added a dependency-
free in-memory sliding-window limiter (`src/auth/rateLimit.ts`) on
`/auth/otp/request` (5/15min), `/auth/otp/verify` (10/15min),
`/agent/auth/device-login` (30/15min), `/admin/auth/login` (5/15min), and
`/admin/auth/forgot-password` (3/hour), keyed by IP + route.

**Stated limitation, not hidden**: this is in-memory, so limits reset on a
restart/redeploy and don't share state across multiple server instances.
Fine for Render's free tier (one instance); genuinely insufficient once you
scale horizontally, at which point this needs a shared store (Redis)
instead — noted in the file itself too.

## Roles

Four, per the spec: `super_admin`, `admin`, `agent`, `customer`.
- **Super Admin**: everything, including creating/deleting other Admin
  accounts, per-provider PINs, system settings.
- **Admin**: day-to-day operations (customers, agents, orders, packages,
  companies, reports) — cannot manage other staff accounts or PINs.
- **Agent**: only `/agent/*` routes (own orders, SMS log upload, own
  transaction history).
- **Customer**: only `/orders`, `/auth/otp/*` and their own resources.

## Setup

```bash
npm install
cp .env.example .env       # fill in DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY
npm run build
npm run migrate             # applies src/db/migrations/001_init.sql
npm start
```

`npm run dev` runs directly against `src/` via `tsx` without a build step,
for local iteration.

## Deploying to Render

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, point it at the repo — `render.yaml`
   provisions both the Postgres database and the web service in one go.
3. Render will prompt for `SEED_SUPER_ADMIN_EMAIL` /
   `SEED_SUPER_ADMIN_PASSWORD` (marked `sync: false` so they're not
   auto-generated) — set these to your real first-login credentials.
4. Build command (already set in render.yaml):
   `npm install && npm run build && npm run migrate`
5. Start command (already set): `npm start`
6. Once live, `GET /health` returns `{ status: "ok", database: "connected" }`
   if the DB connection is actually working — check this first if anything
   seems wrong after deploy.

## Modules implemented

Auth (OTP for customers, password login for agents/staff, refresh tokens,
forgot/reset/change password) · Admin user management (Super Admin only) ·
Companies & packages · Orders (full lifecycle + cross-network payment
matching) · Customers · Agents · SMS logs · Reports · **Settings** (new
key/value system config module, per the spec's "settings page" requirement)
· USSD templates + per-provider encrypted PINs · Multi-device SIM routing
(Mobile 1/Mobile 2 style config) · Macaash rewards · Banners · Notifications.

This now matches the SQLite backend's full module set — same business logic
throughout, translated to `pg` parameterized queries and Postgres syntax.

## Ready for the Agent and Customer APKs

Every `/agent/*` and customer-facing route (`/auth/otp/*`, `/orders`) already
exists with the same request/response shapes as the SQLite backend the
native Kotlin Agent App and Customer App were built against — pointing
either at this backend instead is a base-URL change, not a rewrite.
