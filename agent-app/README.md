# DALAB Agent App — Android module

**Want an installable APK without setting up Android Studio?** Push this repo
to GitHub and the included `.github/workflows/build-apk.yml` builds a real
debug APK automatically on GitHub's own servers (which have the Android SDK
— this sandbox doesn't). After the push, go to the repo's **Actions** tab,
open the latest run, and download the `dalab-agent-debug-apk` artifact —
that's a real, installable APK, not a placeholder.

**Two things you must do before this builds, and why they can't be pre-filled:**
1. `gradle/wrapper/gradle-wrapper.jar` is missing — it's a compiled binary, not
   text, so it can't be generated in this environment. Run `gradle wrapper`
   once (any local Gradle install) or open the project in Android Studio,
   which regenerates it automatically.
2. Copy `local.properties.example` → `local.properties` and set `sdk.dir` to
   your Android SDK path (Android Studio also does this automatically).

This is a real Kotlin/Jetpack Compose Android app skeleton, not a mockup — it's meant
to be dropped into a new Android Studio project (or a module in an existing
multi-app repo) and built against the backend described in
`dalab-backend-architecture.md`. Nothing here runs in the browser; it needs the
Android SDK and a real API server to actually function.

## What's implemented

- **First-launch permission flow** (`MainActivity`, `SmsPermissionScreen`) —
  requests `READ_SMS` + `RECEIVE_SMS`, shows a plain-language rationale, and falls
  back to an **Open App Settings** button if the agent denies permanently.
- **Agent login** (`LoginScreen`, `AuthRepository`, `SessionManager`) — phone +
  password against `POST /agent/auth/login`, JWT stored locally.
- **SMS listener** (`SmsReceiver`, `PaymentSmsParsers`, `SmsListenerState`) — parses
  incoming Hormuud/EVC Plus confirmation SMS (same pattern used in the Super Admin
  SMS listener built earlier), uploads matches to `POST /agent/sms-logs`, and
  notifies the agent when the server matches it to a pending order.
- **Orders list + detail** (`OrdersListScreen`, `OrderDetailScreen`) — view pending
  orders, see customer + package detail, **Verify Payment**, then **Mark as
  Completed**.
- **Transaction history** (`TransactionHistoryScreen`).
- **Real-time sync** (`RealtimeClient`) — a WebSocket connection so order updates
  from the Customer App or Super Admin Web show up without polling.
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
- `RealtimeClient` doesn't reconnect automatically on failure — add exponential
  backoff before relying on it in production.
- App icon / `ic_notification` drawable, `strings.xml`, and theme colors aren't
  included — this skeleton focuses on structure and logic, not visual polish (the
  Customer App and Admin Dashboard prototypes already establish the DALAB brand
  colors — indigo `#1D2E8C`, green `#16A34A` — reuse those here for consistency).

## Integration checklist

1. Create a new Android Studio project (or module) targeting package
   `com.dalab.internet`.
2. Copy `app/src/main/java/com/dalab/internet/**` in as-is.
3. Merge `AndroidManifest_additions.xml` into your manifest.
4. Merge `app/build.gradle.kts.snippet` into your `dependencies { }` block.
5. Point `ApiClient.BASE_URL` and `RealtimeClient`'s WebSocket URL at your real
   API host once it exists.
6. Build the backend routes this expects — see `dalab-backend-architecture.md`
   §4 "Agent-facing" and §3 for the `agents` / `sms_logs` table additions, and
   §5a for the role-based access control this app's JWT relies on.
