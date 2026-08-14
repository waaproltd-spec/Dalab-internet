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
 * Sends the same title/body/data payload to every token in [tokens],
 * chunked to FCM's 500-tokens-per-call multicast limit, and deletes any
 * token FCM reports as no-longer-registered (app uninstalled, token
 * rotated and the old one never got cleaned up client-side) so the next
 * send to this customer doesn't keep wasting a call on a dead device.
 * `data` values must all be strings — FCM's data-payload requirement — and
 * are what the Flutter side reads to route a notification tap to the right
 * screen (see NotificationsScreen/main.dart's background-tap handler).
 */
export async function sendPushToTokens(
  tokens: string[],
  payload: { title: string; body: string; data: Record<string, string> }
): Promise<PushResult> {
  const firebaseApp = getApp();
  if (!firebaseApp || tokens.length === 0) {
    return { attempted: 0, sent: 0, failed: 0 };
  }
  const messaging = getMessaging(firebaseApp);
  const CHUNK = 500;
  let sent = 0;
  let failed = 0;
  const deadTokens: string[] = [];

  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    try {
      const result = await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        android: { priority: "high", notification: { channelId: "dalab_notifications" } },
        apns: { payload: { aps: { sound: "default" } } },
      });
      sent += result.successCount;
      failed += result.failureCount;
      result.responses.forEach((r, idx) => {
        const code = r.error?.code;
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
          deadTokens.push(chunk[idx]);
        }
      });
    } catch (err) {
      console.error("FCM sendEachForMulticast failed for a chunk:", (err as Error).message);
      failed += chunk.length;
    }
  }

  if (deadTokens.length > 0) {
    await query(`DELETE FROM customer_push_tokens WHERE token = ANY($1::text[])`, [deadTokens]).catch((err) => {
      console.error("Failed to prune dead push tokens:", (err as Error).message);
    });
  }

  return { attempted: tokens.length, sent, failed };
}
