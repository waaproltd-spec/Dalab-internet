# DALAB Customer App — Android (Kotlin + Jetpack Compose)

The native Android counterpart to the [`customer-app`](../customer-app) React
web prototype, wired to the same production backend
(`admin-backend-ts`, at `https://dalab-admin-backend.onrender.com/` — see
`ApiClient.kt`). A standalone Gradle project (own `gradlew`,
`settings.gradle.kts`) — open `customer-app-android/` directly in Android
Studio, or build it headlessly via the GitHub Actions workflow below.

**Want an installable APK without setting up Android Studio?** Push this repo
to GitHub and the root-level `.github/workflows/customer-app-build-apk.yml`
builds a real debug APK automatically on GitHub's own servers. After the
push, go to the repo's **Actions** tab, open the latest run, and download the
`dalab-customer-debug-apk` artifact. See "Release APK" below for a signed build.

**One thing you may still need to do locally:** copy
`local.properties.example` → `local.properties` and set `sdk.dir` to your
Android SDK path if building from Android Studio/a local Gradle install.

## What's implemented

- **Account creation + login** (`OtpLoginScreen`) — a single OTP flow handles
  both: `POST /auth/otp/request` + `POST /auth/otp/verify` creates the
  customer record on first use (same as the backend does for the web app),
  and if it's a brand-new account (no name on file yet) the screen prompts
  for one via `PUT /customer/profile` before entering the app.
- **Buy internet packages** (`HomeScreen`) — browse providers (Hormuud,
  Somnet, Somtel, Amtel) and their live package catalog
  (`GET /companies`, `GET /companies/{id}/packages`); offline providers are
  shown but disabled, matching the web app's behavior.
- **Payment options** (`CheckoutScreen`) — confirms the order against the
  provider's real gateway (EVC Plus / JEEB / eDahab / Manual — from
  `company.gateway`) and a receiver number, then places the order
  (`POST /orders`).
- **Order tracking + history** (`OrdersScreen`, `OrderDetailScreen`) — every
  order the customer has placed (`GET /orders`, `GET /orders/{id}`), status
  (awaiting payment / confirmed / completed / failed / cancelled), and
  Macaash points earned once completed.
- **Profile** (`ProfileScreen`) — name, phone, live Macaash points balance
  (`GET /macaash/balance`), log out.
- **Session handling** (`SessionManager`, `ApiClient`) — JWT access/refresh
  tokens with automatic one-shot refresh-and-retry on a 401, same pattern as
  the Agent App.

## What's intentionally out of scope here

- Macaash **rewards redemption** (the catalog/redeem flow) — the balance is
  shown on Profile, but redeeming points for rewards isn't built into this
  app; the backend already supports it (`GET /macaash/rewards`,
  `POST /macaash/redeem`) if you want to add a screen for it later.
- Push notifications / banners — the backend has endpoints for both
  (`notifications`, `banners`) but no UI consumes them here yet.
- `SessionManager` uses plain `SharedPreferences` for brevity; swap in
  `EncryptedSharedPreferences` (dependency already listed in
  `app/build.gradle.kts`) before shipping, since it's holding JWTs.

## Release APK

`build-apk.yml` builds and uploads a signed **release** APK on every push to
`main` that touches `customer-app-android/`, alongside the debug build.
Signing needs four repository secrets (Settings → Secrets and variables →
Actions):

- `CUSTOMER_KEYSTORE_BASE64` — your release keystore (`.jks`/`.keystore`), base64-encoded
- `CUSTOMER_KEYSTORE_PASSWORD`
- `CUSTOMER_KEY_ALIAS`
- `CUSTOMER_KEY_PASSWORD`

Generate a keystore yourself (never share or commit it):

```bash
keytool -genkeypair -v -keystore customer-release.jks -alias dalab-customer \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 customer-release.jks   # paste the output into CUSTOMER_KEYSTORE_BASE64
```

Without those secrets set, the release build step is skipped automatically —
the debug APK still builds either way.
