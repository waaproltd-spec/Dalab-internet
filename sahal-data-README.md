# Sahal Data

Sahal Data — a multi-network internet/data reseller platform for Somalia
(Hormuud, Somnet, Somtel, Amtel), with agent-assisted payment verification via
SMS, USSD-based top-ups, and a Macaash customer rewards ledger.

This is a fully independent copy of the original project's monorepo,
rebranded top to bottom (app names, package/application IDs, launcher icons,
splash strings, notifications, docs, backend service names, and
dashboard/API branding) and kept side by side with the original project
without modifying or deleting any of its files. It carries the same features
and behavior as the original — only the brand and identifiers changed.

| Directory | What it is |
|---|---|
| [`sahal-data-admin-backend-ts/`](sahal-data-admin-backend-ts) | **Primary production backend.** Node.js + Express + TypeScript + PostgreSQL. Auth (customer OTP, staff/agent password login), companies/packages/orders, customers, agents, reports, settings, USSD templates, SIM routing, Macaash, banners, notifications. |
| [`sahal-data-backend/`](sahal-data-backend) | Legacy/reference backend (Node.js + `node:sqlite`, no external deps). Same route surface as `sahal-data-admin-backend-ts`, kept for reference only — not used in production. |
| [`sahal-data-super-admin-app/`](sahal-data-super-admin-app) | Super Admin web dashboard (React + Vite). Companies, payment numbers, packages, orders, customers, Macaash, notifications, banners, USSD services, SIM routing setup, reports, settings. |
| [`sahal-data-agent-app/`](sahal-data-agent-app) | Native Android app (Kotlin + Jetpack Compose, package `com.sahal.data`) for field agents — login, customer management, walk-in sales, package catalog, order verification/completion, transaction history, an SMS listener that matches payment-confirmation messages to pending orders, and the agent's own sales reports. |

**Customer App:** the real, current Sahal Data Customer App is a Flutter
rebuild and lives in the `waaproltd-spec/dalab-internet-2` repo, at
`sahal-data-customer-app/` — see that repo's README. The React web app and
native Kotlin app that used to live here (`sahal-data-customer-app/`,
`sahal-data-customer-app-android/`) were rebrands of an older, superseded
customer app and have been removed.

## Backend

Every frontend here points at `sahal-data-admin-backend-ts` by default at
the placeholder URL `https://sahal-data-2.onrender.com/` — this is **not a
live deployment**; deploy `sahal-data-admin-backend-ts` yourself (see its
README/`render.yaml`) and update `BASE_URL` / `VITE_API_BASE_URL` in each
client to the real deployed URL. The plain `sahal-data-backend/` package is
legacy/reference only and should not be used alongside it. This backend and
its database are entirely separate from the original project's backend — no
data or infrastructure is shared. The Sahal Data Customer App (in
`dalab-internet-2`) points at this same backend.

## Android app / CI

`sahal-data-agent-app` is a standalone Gradle project with its own
application ID (`com.sahal.agent`, mirroring the original's own
applicationId scheme), so it can be installed side by side with the
original project's apps without conflict. The root-level GitHub Actions
workflow (`.github/workflows/sahal-data-agent-app-build-apk.yml`) builds an
installable debug APK on every push to `main` that touches it, and a
signed release APK once you've configured its keystore secrets — see its
README under "Release APK".

## Branding assets

Launcher icons and the Super Admin dashboard logo/favicon all use the Sahal
Data brand mark — a two-tone swirl "S" (blue `#1B368D`, orange `#E99D13`)
— see `sahal-data-branding/` for the source artwork and the full brand
palette. Every app's primary chrome (buttons, headers, active nav,
gradients) was re-themed to this blue/orange palette; existing green/red/
amber status and third-party payment-provider colors were deliberately
left alone (see `sahal-data-branding/README.md` for why). Swap the mark
for professional artwork whenever you have it — see each app's
`res/mipmap-*` (Android) or `public/` (web) folder for where the generated
PNGs live. The Customer App (in `dalab-internet-2`) uses the same mark and
palette — see its own README/branding notes.

## Getting started

Each subdirectory is a self-contained project with its own `package.json` (or
Gradle build for the two Android apps) and its own README with setup
instructions.
