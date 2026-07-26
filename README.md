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
| [`super-admin-app/`](super-admin-app) | Super Admin web dashboard (React + Vite). Companies, payment numbers, packages, orders, customers, Macaash, notifications, banners, USSD services, SIM routing setup, reports, settings. |
| [`agent-app/`](agent-app) | Native Android app (Kotlin + Jetpack Compose) for field agents — login, view/verify/complete orders, transaction history, and an SMS listener that detects payment-confirmation messages and matches them to pending orders. |
| [`agent-app-rn/`](agent-app-rn) | Standalone React Native module (`@dalab/agent-sms-listener`) implementing the same SMS payment-detection pipeline as `agent-app`, for a React Native version of the Agent App. |

## Backend

All frontends and the native Agent App point at `admin-backend-ts` — see its
README for setup, deployment (Render), and role model
(`super_admin` / `admin` / `agent` / `customer`). The plain `backend/` package
is legacy/reference only and should not be used alongside it.

## Getting started

Each subdirectory is a self-contained project with its own `package.json` (or
Gradle build for `agent-app`) and its own README with setup instructions.
