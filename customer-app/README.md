# DALAB INTERNET — Customer App

```bash
npm install
cp .env.example .env
npm run dev
```

**Primary backend: `dalab-admin-backend-ts`** (Node.js + Express + TypeScript
+ PostgreSQL) — this is the one production backend for the whole project.
The earlier SQLite/plain-Node backend (`dalab-backend.zip`) is legacy/
reference only; don't point this app at both, and don't mix request/response
assumptions between them even though the shapes are verified identical (see
that backend's README for the route-by-route and field-by-field diff that
confirmed this).

Set `VITE_API_BASE_URL` in `.env` to the deployed TS backend's URL to switch
from demo/mock data to the live API — e.g.
`VITE_API_BASE_URL=https://dalab-internet-2.onrender.com`. Build for
production with `npm run build` (output in `dist/`).
