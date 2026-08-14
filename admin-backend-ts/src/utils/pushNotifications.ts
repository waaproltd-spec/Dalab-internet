import { initializeApp, cert, getApps, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { query } from "../db/pool.js";

/**
 * Real push delivery (FCM) for the notifications table's per-customer rows
 * — see 050_notifications_push.sql. Deliberately never throws: a customer's
 * notification ROW (the in-app history) must always be created regardless
 * of whether push is configured or a given send fails, so the caller (see
 * notifications.routes.ts's POST /admin/notifications/send) always gets a
 * usable in-app notification even before FIREBASE_SERVICE_ACCOUNT_JSON is
 * set, or if FCM itself is having a bad day.
 *
 * FIREBASE_SERVICE_ACCOUNT_JSON holds the *entire* contents of the service
 * account key file Firebase Console -> Project Settings -> Service Accounts
 * -> Generate new private key produces, pasted as-is (it's already valid
 * single-line-safe JSON with \n-escaped newlines in private_key). Until
 * that env var is set, isPushConfigured() is false and every send is a
 * documented no-op — the notification still reaches the in-app inbox, it
 * just doesn't reach a phone that has the app closed yet.
 */
let app: App | null | undefined; // undefined = not yet attempted, null = attempted and unavailable

function getApp(): App | null {
  if (app !== undefined) return app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    app = null;
    return app;
  }
  try {
    const serviceAccount = JSON.parse(raw);
    app = getApps()[0] ?? initializeApp({ credential: cert(serviceAccount) });
  } catch (err) {
    console.error("Failed to initialize Firebase Admin from FIREBASE_SERVICE_ACCOUNT_JSON:", (err as Error).message);
    app = null;
  }
  return app;
}

export function isPushConfigured(): boolean {
  return getApp() !== null;
}

export interface PushResult {
  attempted: number;
  sent: number;
  failed: number;
}

/**
 * Sends [notification] to every recipient in [recipients], chunked to FCM's
 * 500-messages-per-call sendEach limit, and deletes any token FCM reports as
 * no-longer-registered (app uninstalled, token rotated and the old one never
 * got cleaned up client-side) so the next send to this customer doesn't keep
 * wasting a call on a dead device.
 *
 * Each recipient carries its own `data` (all values must be strings — FCM's
 * data-payload requirement) rather than one shared payload, specifically so
 * `data.notificationId` can be that recipient's own row id from the
 * per-customer fan-out insert (see notifications.routes.ts) — the Flutter
 * side needs that exact id to mark the right row read and to show its full
 * message on tap, not just route to the general notifications list.
 */
export async function sendPushToTokens(
  recipients: { token: string; data: Record<string, string> }[],
  notification: { title: string; body: string }
): Promise<PushResult> {
  const firebaseApp = getApp();
  if (!firebaseApp || recipients.length === 0) {
    return { attempted: 0, sent: 0, failed: 0 };
  }
  const messaging = getMessaging(firebaseApp);
  const CHUNK = 500;
  let sent = 0;
  let failed = 0;
  const deadTokens: string[] = [];

  for (let i = 0; i < recipients.length; i += CHUNK) {
    const chunk = recipients.slice(i, i + CHUNK);
    try {
      const result = await messaging.sendEach(
        chunk.map((r) => ({
          token: r.token,
          notification: { title: notification.title, body: notification.body },
          data: r.data,
          android: { priority: "high" as const, notification: { channelId: "dalab_notifications" } },
          apns: { payload: { aps: { sound: "default" } } },
        }))
      );
      sent += result.successCount;
      failed += result.failureCount;
      result.responses.forEach((r, idx) => {
        const code = r.error?.code;
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
          deadTokens.push(chunk[idx].token);
        }
      });
    } catch (err) {
      console.error("FCM sendEach failed for a chunk:", (err as Error).message);
      failed += chunk.length;
    }
  }

  if (deadTokens.length > 0) {
    await query(`DELETE FROM customer_push_tokens WHERE token = ANY($1::text[])`, [deadTokens]).catch((err) => {
      console.error("Failed to prune dead push tokens:", (err as Error).message);
    });
  }

  return { attempted: recipients.length, sent, failed };
}
