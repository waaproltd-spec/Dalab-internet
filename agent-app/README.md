# DALAB Agent App — Android module

A real Kotlin + Jetpack Compose Android app, wired to the deployed production
backend (`admin-backend-ts`, at `https://api.waaproltd.com/` — see
`ApiClient.kt`). It's a standalone Gradle project (own `gradlew`,
`settings.gradle.kts`) — open `agent-app/` directly in Android Studio, or build
it headlessly via the GitHub Actions workflow below.

**Want an installable APK without setting up Android Studio?** Push this repo
to GitHub and the root-level `.github/workflows/agent-app-build-apk.yml`
builds a real debug APK automatically on GitHub's own servers (which have the
Android SDK).
After the push, go to the repo's **Actions** tab, open the latest run, and
download the `dalab-agent-debug-apk` artifact — that's a real, installable
APK, not a placeholder. See "Release APK" below for a signed build.

**One thing you may still need to do locally:** copy
`local.properties.example` → `local.properties` and set `sdk.dir` to your
Android SDK path if building from Android Studio/a local Gradle install
(Android Studio does this automatically; the GitHub Actions workflow doesn't
need it since it installs the SDK itself).

## What's implemented

- **First-launch permission flow** (`MainActivity`, `SmsPermissionScreen`) —
  requests `READ_SMS` + `RECEIVE_SMS`, shows a plain-language rationale, and falls
  back to an **Open App Settings** button if the agent denies permanently.
- **Agent login** (`AutoLoginScreen`, `AuthRepository`, `SessionManager`) — no
  credentials at all; the app authenticates itself against
  `POST /agent/auth/device-login` using whichever agent is assigned to this
  device (`DeviceIdentity`), JWT stored locally.
- **Customer management** (`CustomersScreen`) — search existing customers by
  name/phone, or register a new walk-in customer (`GET`/`POST /agent/customers`).
- **Sales** (`NewSaleScreen`) — pick a provider, pick a package, enter the
  customer's phone and payment method, submit (`POST /agent/orders`) — creates
  the order and the customer record if they don't have one yet, same as the
  Customer App's OTP signup does.
- **Packages** (`PackagesScreen`) — browse the full catalog and live pricing
  per provider (`GET /companies`, `GET /companies/{id}/packages`).
- **Orders list + detail** (`OrdersListScreen`, `OrderDetailScreen`) — view pending
  orders, see customer + package detail, **Verify Payment**, then **Mark as
  Completed**.
- **Transaction history** (`TransactionHistoryScreen`).
- **Reports** (`ReportsScreen`) — the agent's own completed-sales totals and
  daily/weekly/monthly/yearly breakdown (`GET /agent/reports`).
- **SMS listener** (`SmsReceiver`, `PaymentSmsParsers`, `SmsListenerState`) — parses
  incoming Hormuud/EVC Plus confirmation SMS (same pattern used in the Super Admin
  SMS listener built earlier), uploads matches to `POST /agent/sms-logs`, and
  notifies the agent when the server matches it to a pending order.
- **Real-time sync** (`RealtimeClient`) — a Server-Sent Events connection
  (`GET /agent/orders/stream`) with reconnect-with-backoff, wired into
  `OrdersListScreen`, so order updates from the Customer App or Super Admin
  Web show up without polling.
- **Boot persistence** (`BootReceiver`) — listening state survives a device restart.

## What's intentionally left as TODOs

- Somtel/eDahab and Somnet/JEEB SMS parsers — only Hormuud/EVC Plus's format was
  confirmed; add the other two in `PaymentSmsParsers.kt` following the same shape
  once you have real sample messages.
- ~~Token refresh~~ — implemented: `ApiClient` now uses an OkHttp `Authenticator`
  that calls `POST /auth/refresh` on a 401, retries the original request once with
  the new access token, and only forces re-login if the refresh token itself is
  expired/revoked. See `network/ApiClient.kt`.
- `SessionManager` uses plain `SharedPreferences` for brevity; swap in
  `EncryptedSharedPreferences` (dependency already listed in the Gradle snippet)
  before shipping, since it's holding JWTs.
- Visual polish is minimal — app icon, `ic_notification`, `strings.xml`, and
  theme colors exist (reusing the DALAB brand colors — indigo `#1D2E8C`,
  green `#16A34A` — established by the Customer App and Admin Dashboard
  prototypes) but this skeleton focuses on structure and logic, not design.

## Release APK

`build-apk.yml` builds and uploads a signed **release** APK on every push to
`main` that touches `agent-app/`, alongside the existing debug build. Signing
needs four repository secrets (Settings → Secrets and variables → Actions):

- `AGENT_KEYSTORE_BASE64` — your release keystore (`.jks`/`.keystore`), base64-encoded
- `AGENT_KEYSTORE_PASSWORD`
- `AGENT_KEY_ALIAS`
- `AGENT_KEY_PASSWORD`

Generate a keystore yourself (never share or commit it):

```bash
keytool -genkeypair -v -keystore agent-release.jks -alias dalab-agent \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 agent-release.jks   # paste the output into AGENT_KEYSTORE_BASE64
```

Without those secrets set, the release build step is skipped automatically —
the debug APK still builds either way, so CI never fails for a fork/PR that
doesn't have signing configured.

## Push notifications (Agent Support)

The Agent App receives a real push notification (via Firebase Cloud
Messaging) whenever a customer sends it a new Agent Support message. This
needs one manual, one-time step that only someone with access to the
Firebase Console can do — it is **not** something CI or this repo's code
can set up on its own:

1. Open the Firebase Console for the existing `dalab-internet` project (the
   same project the Customer App already uses for its own push).
2. Add a new Android app under that project with package name
   `com.dalab.agent` (not `com.dalab.internet` — that's the Customer App's
   own, already-registered package).
3. Download the `google-services.json` Firebase generates for that new app.
4. For a local/manual build: place the file at `agent-app/app/google-services.json`.
   For CI: base64-encode it and set it as the `AGENT_GOOGLE_SERVICES_JSON_BASE64`
   repository secret (Settings → Secrets and variables → Actions):

```bash
base64 -w0 google-services.json   # paste the output into AGENT_GOOGLE_SERVICES_JSON_BASE64
```

Without this file, the app still builds and installs normally — the
`google-services` Gradle plugin only applies when the file is present — but
push notifications stay silently inert: Firebase never initializes, so no
device token is ever registered and the backend has nothing to send to.
