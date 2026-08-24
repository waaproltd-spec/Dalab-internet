// Firebase Cloud Messaging wrapper — the only file in this codebase that
// talks to Firebase. Configured either way:
//
//   1. FIREBASE_SERVICE_ACCOUNT_PATH — path to the service-account JSON file
//      downloaded from Firebase Console > Project Settings > Service
//      Accounts > Generate new private key, placed directly on the server
//      (outside the repo, permissions locked down — see deploy notes).
//      Preferred: firebase-admin's cert() reads the file itself, so the
//      private key's embedded newlines never have to survive a round trip
//      through a single-line env var.
//   2. FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY —
//      the same three fields as separate env vars (private key with its
//      newlines \n-escaped), for setups where a file on disk isn't an
//      option. Checked only if (1) isn't set.
//
// Every export here is best-effort: a push failure must never fail the
// order/exchange/campaign action that triggered it (same rule
// notifyCustomer in customerNotify.ts and exchange.routes.ts already
// follow for the in-app notifications table).

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { query } from "../db/pool.js";

let initAttempted = false;
let configured = false;

/** Lazy, once-only init — most local/dev/test runs set neither of these,
 * and importing this module must not throw just because they're unset
 * (mirrors requiredEnv()'s callers in somlink.ts, which only throw at the
 * point a send is actually attempted, not at import time). */
function ensureInitialized(): boolean {
  if (initAttempted) return configured;
  initAttempted = true;

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (serviceAccountPath) {
    if (getApps().length === 0) {
      initializeApp({ credential: cert(serviceAccountPath) });
    }
    configured = true;
    return true;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Env vars can't hold a literal newline — the downloaded JSON key's
  // private_key field is stored with the \n escape sequences intact and
  // un-escaped here, the standard pattern for pasting a PEM key into an
  // env var.
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    // eslint-disable-next-line no-console
    console.warn(
      "Push notifications disabled: set FIREBASE_SERVICE_ACCOUNT_PATH, or all three of FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY."
    );
    return false;
  }

  if (getApps().length === 0) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }
  configured = true;
  return true;
}

export function isPushConfigured(): boolean {
  return ensureInitialized();
}

export interface PushPayload {
  title: string;
  body: string;
  /** Arbitrary string key/value data delivered alongside the notification —
   * e.g. {"screen":"notifications","orderId":"DLB..."} — read by the app's
   * background/terminated-state handler to decide what tapping it opens.
   * FCM requires every data value to be a string. */
  data?: Record<string, string>;
  /** Android notification channel to post into — the receiving app must have
   * already created a channel with this id (Android 8+), or the OS silently
   * drops the notification. Defaults to "dalab_updates" (the Customer App's
   * existing channel); the Agent App's support-request push uses its own
   * "support_requests" channel instead, see support.routes.ts. */
  channelId?: string;
}

interface SendResult {
  /** Tokens FCM rejected outright (invalid/unregistered) — the caller
   * should delete these rows so a future send doesn't keep retrying them. */
  invalidTokens: string[];
  successCount: number;
  failureCount: number;
}

const UNREGISTERED_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/** Sends to an arbitrary batch of raw FCM tokens (FCM's own multicast limit
 * is 500 per call) — the shared primitive both sendPushToCustomer and the
 * campaign broadcaster build on. Never throws: a total failure to reach FCM
 * (network error, bad credentials) comes back as failureCount === tokens.length
 * with an empty invalidTokens list, since that failure says nothing about
 * whether any individual token is actually bad. */
export async function sendPushToTokens(tokens: string[], payload: PushPayload): Promise<SendResult> {
  if (tokens.length === 0) return { invalidTokens: [], successCount: 0, failureCount: 0 };
  if (!ensureInitialized()) return { invalidTokens: [], successCount: 0, failureCount: tokens.length };

  const invalidTokens: string[] = [];
  let successCount = 0;
  let failureCount = 0;

  try {
    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);
      const response = await getMessaging().sendEachForMulticast({
        tokens: batch,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        android: {
          // 'high' wakes the device to deliver immediately even while
          // Doze/App Standby would otherwise defer a normal-priority
          // message — required for the "closed app" case the notification
          // still needs to reach.
          priority: "high",
          notification: { channelId: payload.channelId ?? "dalab_updates" },
        },
      });
      response.responses.forEach((r, idx) => {
        if (r.success) {
          successCount++;
        } else {
          failureCount++;
          // Previously silent -- successCount/failureCount alone gave no way
          // to tell "wrong project credentials", "token belongs to a
          // different Firebase project", "unregistered token", and a dozen
          // other FCM failure modes apart from each other. Token itself is
          // truncated (not a secret, but no reason to spam full tokens into
          // logs) -- the real diagnostic value is r.error.code/message.
          // eslint-disable-next-line no-console
          console.error(
            `FCM send failed for token ...${batch[idx].slice(-10)}: ${r.error?.code ?? "unknown"} - ${r.error?.message ?? "no message"}`
          );
          if (r.error && UNREGISTERED_ERROR_CODES.has(r.error.code)) {
            invalidTokens.push(batch[idx]);
          }
        }
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("FCM send failed:", (err as Error).message);
    return { invalidTokens: [], successCount, failureCount: tokens.length - successCount };
  }

  return { invalidTokens, successCount, failureCount };
}

/** Looks up every device token registered for a customer, sends to all of
 * them, and prunes any FCM confirms are dead. Returns whether at least one
 * token received it — customerNotify.ts uses this only to decide the
 * campaign-recipient status, never to gate the in-app notifications-table
 * row (that's written unconditionally so the in-app feed never depends on
 * push being configured at all). */
export async function sendPushToCustomer(
  customerId: string,
  payload: PushPayload
): Promise<{ attempted: boolean; delivered: boolean }> {
  try {
    const rows = await query<{ fcm_token: string }>(
      `SELECT fcm_token FROM customer_device_tokens WHERE customer_id=$1`,
      [customerId]
    );
    if (rows.length === 0) return { attempted: false, delivered: false };

    const tokens = rows.map((r) => r.fcm_token);
    const result = await sendPushToTokens(tokens, payload);

    if (result.invalidTokens.length > 0) {
      await query(`DELETE FROM customer_device_tokens WHERE fcm_token = ANY($1)`, [result.invalidTokens]);
    }
    return { attempted: true, delivered: result.successCount > 0 };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("sendPushToCustomer failed:", (err as Error).message);
    return { attempted: true, delivered: false };
  }
}

/** Same as sendPushToCustomer, but for a native Agent App login (the `agents`
 * table, agent_device_tokens — see migration 064). Only ever called for a
 * role==='agent' actor: Admin Dashboard staff (admin_users) handle support
 * from the browser and never register an FCM token, so there is nothing to
 * look up for them — see support.routes.ts's notifyAssignedAgent(). */
export async function sendPushToAgent(
  agentId: string,
  payload: PushPayload
): Promise<{ attempted: boolean; delivered: boolean }> {
  try {
    const rows = await query<{ fcm_token: string }>(
      `SELECT fcm_token FROM agent_device_tokens WHERE agent_id=$1`,
      [agentId]
    );
    if (rows.length === 0) return { attempted: false, delivered: false };

    const tokens = rows.map((r) => r.fcm_token);
    const result = await sendPushToTokens(tokens, payload);

    if (result.invalidTokens.length > 0) {
      await query(`DELETE FROM agent_device_tokens WHERE fcm_token = ANY($1)`, [result.invalidTokens]);
    }
    return { attempted: true, delivered: result.successCount > 0 };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("sendPushToAgent failed:", (err as Error).message);
    return { attempted: true, delivered: false };
  }
}
