// The single "notify a customer about something that happened to their
// account" entry point — writes the existing in-app notifications-table row
// (unchanged behavior, always happens) and additionally sends a real push
// via FCM (push.ts) if that customer has a registered device (a no-op if
// they don't, or if push isn't configured at all — see push.ts). Both
// halves are best-effort: a failure in either must never fail the
// order/exchange status change that triggered this call, so this function
// itself never throws.

import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";
import { sendPushToCustomer } from "./push.js";

export async function notifyCustomer(
  customerId: string | null | undefined,
  type: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<{ delivered: boolean }> {
  if (!customerId) return { delivered: false };
  // Generated here (rather than left to the DB's gen_random_uuid() default)
  // so the same id and timestamp can also ride along in the push payload
  // below — the customer app's notification-tap handler needs both to open
  // the exact tapped notification's detail view without a network round
  // trip, including when the tap cold-starts the app with no connectivity
  // yet.
  const id = randomUUID();
  const sentAt = new Date().toISOString();
  try {
    // data is persisted too (not just pushed) so the in-app notifications
    // list itself can carry structured routing info specific to a
    // notification's type, for the customer app's notification card to act
    // on without a second lookup.
    await query(`INSERT INTO notifications (id, type, title, body, customer_id, sent_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      id,
      type,
      title,
      body,
      customerId,
      sentAt,
      data ? JSON.stringify(data) : null,
    ]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to write in-app notification:", (err as Error).message);
  }
  const { delivered } = await sendPushToCustomer(customerId, {
    title,
    body,
    data: { ...data, notificationId: id, notificationType: type, sentAt },
  });
  return { delivered };
}
