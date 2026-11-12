import { queryOne } from "../db/pool.js";

/**
 * Extra Packages (orders.send_count > 1): one paid order delivers the
 * package several times. A delivery counts once it's confirmed -- a
 * successful USSD dial attempt reported by the Agent App, or a successful
 * SOMLINK transaction. Single-delivery orders (send_count 1, every order
 * before Extra Packages existed) never consult this.
 */
export async function deliveriesDone(orderId: string): Promise<number> {
  const row = await queryOne<{ done: string | number }>(
    `SELECT
       (SELECT COUNT(*) FROM ussd_dial_attempts WHERE order_id=$1 AND status='success')
     + (SELECT COUNT(*) FROM somlink_transactions WHERE order_id=$1 AND status='success') AS done`,
    [orderId]
  );
  return Number(row?.done ?? 0);
}

/** Whether every delivery a paid order owes has been confirmed. Always true
 * for a single-delivery order, so its completion paths are unchanged. */
export async function allDeliveriesDone(order: { id: string; send_count?: number | null }): Promise<boolean> {
  const sendCount = Number(order.send_count ?? 1);
  if (sendCount <= 1) return true;
  return (await deliveriesDone(order.id)) >= sendCount;
}
