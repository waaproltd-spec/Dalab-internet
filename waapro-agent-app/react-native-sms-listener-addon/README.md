# useSMSListener — DALAB Agent App (React Native)

Real, type-checked TypeScript implementing the SMS payment-detection pipeline
requested: permission handling → real-time SMS event → parse & validate →
de-duplicate → upload to the existing backend → auto-verify the matched order
→ retry with backoff on failure.

## Read this first: this is a new React Native addition, not a replacement

The Agent App built earlier in this project (`dalab-agent-app.zip`) is
**native Kotlin + Jetpack Compose** — there was no existing React Native
project for it. This delivery is a standalone RN module that implements the
same capability for a React Native version of the Agent App, following the
exact same permission/receiver design as the Kotlin version. It does not
touch or replace `dalab-agent-app.zip`.

## What's real and verified

- **Type-checked for real.** `tsc --noEmit` passes clean (`npm run typecheck`).
  This caught one genuine bug during development — `useSMSListener.ts`
  imported its sibling modules with the wrong relative path (`./nativeSmsBridge`
  instead of `../sms/nativeSmsBridge`, since the hook lives in `src/hooks/`
  and the modules it depends on live in `src/sms/`). Fixed and re-verified.
- **The native Android module is real, complete code** (`android/app/.../sms/`),
  not a JS-only stub assuming a bridge exists — there's no cross-platform JS
  API for reading SMS, so `SmsListenerModule.kt` + `SmsListenerPackage.kt`
  implement the actual `BroadcastReceiver` → `DeviceEventEmitter` bridge,
  reusing the same protected-broadcast reasoning as the native Kotlin app's
  own `SmsReceiver.kt`.
- **The API client matches the real, deployed backend exactly** —
  `POST /agent/sms-logs` and `POST /agent/orders/:id/verify-payment`, same
  paths and body shapes as `dalab-backend.zip`, which has its own passing
  test suite for these routes.

## What's honestly unconfirmed

Only the **Hormuud** SMS parser (`smsParsers.ts` → `hormuudParser`) is built
against a real, confirmed sample message — the same one used throughout this
project (`"[-EVCPLUS-] waxaad $1 ka heshay 0610346060, Tar: 24/07/26"`).

The **Somnet, Somtel, and Amtel** parsers are explicitly labeled
`UNCONFIRMED` in their own doc comments — they're wired up and ready, but
their regex patterns are reasonable guesses, not verified against real
sample messages from those operators. Do not treat them as correct until
you've confirmed the real format and updated the pattern — this was flagged
the same way in the native Kotlin app's own TODO for the same three
operators, and remains true here.

## Security posture (addressing the stated requirements directly)

- **"Only process SMS messages related to payment confirmations. Do not
  read, store, or upload unrelated SMS messages."** Every raw SMS the native
  side delivers is run through `parsePaymentSms()` as the very first step in
  `handleRawSms()`. Anything that isn't a recognized operator's genuinely
  well-formed confirmation is discarded in that same synchronous call —
  before it's logged, stored, or uploaded anywhere. The native Android side
  does receive the OS broadcast for every SMS (that's unavoidable — Android
  doesn't let you subscribe to a filtered subset of SMS), but nothing about
  an unrelated message crosses back into JS-persisted state or the network.
- **Permission handling** (`nativeSmsBridge.ts`) distinguishes a plain
  "denied" (can re-prompt) from "never_ask_again" (permanently denied), and
  `guideToSettings()` deep-links into the app's system Settings page for the
  latter case — matching the requirement to "guide the user to App Settings
  if necessary."
- **De-duplication** is two-layered: an in-memory `Set` for the fast path
  during a single app session, plus a persisted, bounded `SmsProcessedStore`
  (via `AsyncStorage`) so a redelivered `SMS_RECEIVED` broadcast — which
  Android can genuinely produce, e.g. after the app was killed mid-processing
  — doesn't get uploaded twice even across an app restart.
- **Retry with backoff**: failed uploads go into a persisted `SmsRetryQueue`
  (also `AsyncStorage`-backed) and retry with exponential backoff (2s, 4s,
  8s, 16s, 32s) up to `maxRetries` (default 5) — after which they stay
  visible via `pendingRetryCount` rather than being silently dropped.

## Integration

```ts
import { useSMSListener } from "@dalab/agent-sms-listener/src/hooks/useSMSListener";
import { SessionManager } from "./your-existing-auth-module";

function AgentOrdersScreen() {
  const listener = useSMSListener({
    apiBaseUrl: "https://api.dalabinternet.so", // once dalab-backend.zip is deployed
    getAccessToken: () => SessionManager.getAccessToken(), // plug in your existing auth
    onSmsProcessed: (log, matchedOrderId) => {
      if (matchedOrderId) Toast.show(`Order ${matchedOrderId} verified`);
    },
    onError: (err) => console.warn(err.code, err.message),
  });

  // "Start Listening" button:
  const onPressStart = async () => {
    if (listener.state.permissionStatus === "granted") {
      listener.startListening();
    } else {
      const status = await listener.requestPermission();
      if (status === "never_ask_again") listener.guideToSettings();
      else if (status === "granted") listener.startListening();
    }
  };
}
```

## Setting up type-checking yourself

The `typings/` folder contains **minimal, hand-written stand-ins** for the
`react`, `react-native`, and `@react-native-async-storage/async-storage`
types — written only because this sandbox has no network access to install
the real packages. They cover exactly the APIs this module uses, nothing
more. **Delete `typings/` once you `npm install` the real dependencies** in
an actual project — the real packages ship complete, correct types that this
stand-in would otherwise shadow.

```bash
npm install react react-native @react-native-async-storage/async-storage
rm -rf typings
npm run typecheck
```

## Files

```
src/types/sms.ts              — shared types
src/sms/smsParsers.ts         — per-operator parse + validate
src/sms/smsDedupe.ts          — deterministic dedupe key
src/sms/smsRetryQueue.ts      — persisted retry queue
src/sms/smsProcessedStore.ts  — persisted "already uploaded" set
src/sms/nativeSmsBridge.ts    — permissions + native event subscription
src/api/dalabAgentApi.ts      — typed client for the real backend routes
src/hooks/useSMSListener.ts   — the hook itself
android/.../SmsListenerModule.kt   — native bridge (real, not a stub)
android/.../SmsListenerPackage.kt  — RN package registration
android/AndroidManifest_additions.xml
```
