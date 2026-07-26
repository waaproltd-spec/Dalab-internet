# Dalab-internet

Dalab Internet — a multi-network internet/data reseller platform for Somalia
(Hormuud, Somnet, Somtel, Amtel), with agent-assisted payment verification via
SMS, USSD-based top-ups, and a Macaash customer rewards ledger.

This is a monorepo containing every component of the system:

| Directory | What it is |
|---|---|
| [`admin-backend-ts/`](admin-backend-ts) | **Primary production backend.** Node.js + Express + TypeScript + PostgreSQL. Auth (customer OTP, staff/agent password login), companies/packages/orders, customers, agents, reports, settings, USSD templates, SIM routing, Macaash, banners, notifications. |
| [`backend/`](backend) | Legacy/reference backend (Node.js + `node:sqlite`, no external deps). Same route surface as `admin-backend-ts`, kept for reference only — not used in production. |
| [`customer-app/`](customer-app) | Customer-facing web app (React + Vite). Browse packages, place orders, track Macaash points. |
| [`customer-app-android/`](customer-app-android) | Native Android counterpart to `customer-app` (Kotlin + Jetpack Compose) — OTP account creation/login, buy packages, choose a payment method, track orders/history, Macaash balance. |
| [`super-admin-app/`](super-admin-app) | Super Admin web dashboard (React + Vite). Companies, payment numbers, packages, orders, customers, Macaash, notifications, banners, USSD services, SIM routing setup, reports, settings. |
| [`agent-app/`](agent-app) | Native Android app (Kotlin + Jetpack Compose) for field agents — login, customer management, walk-in sales, package catalog, order verification/completion, transaction history, an SMS listener that matches payment-confirmation messages to pending orders, and the agent's own sales reports. |
| [`agent-app-rn/`](agent-app-rn) | Standalone React Native module (`@dalab/agent-sms-listener`) implementing the same SMS payment-detection pipeline as `agent-app`, for a React Native version of the Agent App. |

## Backend

All frontends and both native Android apps point at `admin-backend-ts` —
deployed at `https://dalab-admin-backend.onrender.com/` — see its README for
setup, deployment (Render), and role model
(`super_admin` / `admin` / `agent` / `customer`). The plain `backend/` package
is legacy/reference only and should not be used alongside it.

## Android apps / CI

`agent-app` and `customer-app-android` are each standalone Gradle projects.
Root-level GitHub Actions workflows (`.github/workflows/agent-app-build-apk.yml`,
`.github/workflows/customer-app-build-apk.yml`) build an installable debug APK
on every push to `main` that touches the respective app, and a signed release
APK once you've configured that app's keystore secrets — see each app's README
under "Release APK".

## Getting started

Each subdirectory is a self-contained project with its own `package.json` (or
Gradle build for the two Android apps) and its own README with setup instructions.
