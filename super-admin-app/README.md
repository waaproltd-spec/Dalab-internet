# DALAB INTERNET — Super Admin Dashboard

This is the Super Admin App / Restricted Portal (login screen: "Super Admin
Login", subtitle "Dalab Internet Management Console"). There is no separate
mobile Super Admin app in this project — this single web dashboard is the
Super Admin interface, covering Overview, Companies, Payment Numbers,
Packages, Orders, Customers, Macaash, Notifications, Banners, USSD Services,
SIM Routing Setup, Reports, and Settings.

**Primary backend: `dalab-admin-backend-ts`** (Node.js + Express + TypeScript
+ PostgreSQL) — the one production backend for the whole project. The
earlier SQLite backend is legacy/reference only; don't point this dashboard
at both.

```bash
npm install
cp .env.example .env
npm run dev
```

Set `VITE_API_BASE_URL` in `.env` to the deployed TS backend's URL to switch
from demo/mock data to the live API. Default seeded login:
`admin@example.com` / `ChangeMe123!` (or whatever `SEED_SUPER_ADMIN_EMAIL` /
`SEED_SUPER_ADMIN_PASSWORD` were set to on the backend — change immediately
after first login). Build for production with `npm run build` (output in
`dist/`).
