import { Response } from "express";

// Widened from the original order-only shape to also cover SMS/ledger
// events — safe to widen freely: every existing subscriber (dashboard
// connection status, the Orders panel) already treats any message as an
// opaque "something changed, refetch" signal and never inspects `type`, so
// adding new variants changes no existing runtime behavior.
export type OrderEvent =
  | { type: "order.created" | "order.updated"; orderId: string }
  | { type: "sms_log.created"; smsLogId: string; orderId: string | null }
  | { type: "payment_transaction.updated"; paymentTransactionId: string; orderId: string | null };

const subscribers = new Set<Response>();

// Keeps idle SSE connections alive through proxies/load balancers that would
// otherwise time out a connection with no traffic (Render's included).
const HEARTBEAT_MS = 20_000;
setInterval(() => {
  for (const res of subscribers) res.write(": ping\n\n");
}, HEARTBEAT_MS);

/**
 * Subscribes an already-routed SSE request to order events. Every event goes
 * to every subscriber regardless of role/company — clients re-fetch the
 * referenced order rather than trusting the broadcast payload (same
 * philosophy as the agent app's now-removed dead-code WebSocket client), so
 * there's no need to scope broadcasts server-side.
 */
export function subscribe(res: Response): () => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(": connected\n\n");
  subscribers.add(res);
  return () => subscribers.delete(res);
}

export function broadcast(event: OrderEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers) res.write(payload);
}
