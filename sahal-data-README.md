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
| [`sahal-data-customer-app/`](sahal-data-customer-app) | Customer-facing web app (React + Vite). Browse packages, place orders, track Macaash points. |
| [`sahal-data-customer-app-android/`](sahal-data-customer-app-android) | Native Android counterpart to `sahal-data-customer-app` (Kotlin + Jetpack Compose, package `com.sahal.data.customer`) — OTP account creation/login, buy packages, choose a payment method, track orders/history, Macaash balance. |
| [`sahal-data-super-admin-app/`](sahal-data-super-admin-app) | Super Admin web dashboard (React + Vite). Companies, payment numbers, packages, orders, customers, Macaash, notifications, banners, USSD services, SIM routing setup, reports, settings. |
| [`sahal-data-agent-app/`](sahal-data-agent-app) | Native Android app (Kotlin + Jetpack Compose, package `com.sahal.data`) for field agents — login, customer management, walk-in sales, package catalog, order verification/completion, transaction history, an SMS listener that matches payment-confirmation messages to pending orders, and the agent's own sales reports. |

## Backend

All frontends and both native Android apps point at `sahal-data-admin-backend-ts`
by default at the placeholder URL `https://sahal-data-2.onrender.com/` — this
is **not a live deployment**; deploy `sahal-data-admin-backend-ts` yourself
(see its README/`render.yaml`) and update `BASE_URL` /
`VITE_API_BASE_URL` in each client to the real deployed URL. The plain
`sahal-data-backend/` package is legacy/reference only and should not be used
alongside it. This backend and its database are entirely separate from the
original project's backend — no data or infrastructure is shared.

## Android apps / CI

`sahal-data-agent-app` and `sahal-data-customer-app-android` are each
standalone Gradle projects with their own application IDs
(`com.sahal.data` and `com.sahal.data` / namespace `com.sahal.data.customer`
respectively — mirroring the original's own applicationId scheme), so both
can be installed on the same device as the original project's apps
without conflict. Root-level GitHub Actions workflows
(`.github/workflows/sahal-data-agent-app-build-apk.yml`,
`.github/workflows/sahal-data-customer-app-build-apk.yml`) build an
installable debug APK on every push to `main` that touches the respective
app, and a signed release APK once you've configured that app's keystore
secrets — see each app's README under "Release APK".

## Branding assets

Launcher icons, the web favicon, and the Super Admin dashboard logo are
simple generated "SD" monogram placeholders in the Sahal Data brand colors
(indigo `#1D2E8C` / green `#16A34A`/`#22B24C`, matching the color values the
original project already used). Swap them for real artwork whenever you have
it — see each app's `res/mipmap-*` (Android) or `public/` (web) folder.

One thing that was **not** duplicated: the customer web app's Tawk.to live
chat widget (`sahal-data-customer-app/index.html`) still points at the
original project's Tawk.to account ID, since generating a new one requires an
actual Tawk.to account. Replace `s1.src` in that file with your own Tawk.to
embed URL before relying on live chat support.

## Getting started

Each subdirectory is a self-contained project with its own `package.json` (or
Gradle build for the two Android apps) and its own README with setup
instructions.
