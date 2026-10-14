import { queryOne } from "../db/pool.js";

/** Where a new order for a package comes from. */
export type OrderChannel = "customer" | "agent";

/**
 * Why a new order for this (already active) package must be refused, or
 * null when it can be ordered. The backend is the authority here: an
 * outdated app that still shows a package must not be able to order it
 * once an admin has made it unavailable. Never affects existing orders.
 *
 * - orders_enabled=false: "temporarily unavailable" (still listed).
 * - the package's service category is disabled: the whole service is off.
 * - hidden from the app the order comes from.
 */
export async function packageUnavailableReason(
  pkg: { company_id: string; category_id: string; orders_enabled?: boolean | null; visible_customer_app?: boolean | null; visible_agent_app?: boolean | null },
  channel: OrderChannel
): Promise<string | null> {
  if (pkg.orders_enabled === false) return "This package is temporarily unavailable. Please choose another package.";
  if (channel === "customer" && pkg.visible_customer_app === false) return "This package is not available in the app.";
  if (channel === "agent" && pkg.visible_agent_app === false) return "This package is not available in the Agent App.";
  const category = await queryOne<{ status: string }>(
    `SELECT status FROM service_categories WHERE company_id=$1 AND slug=$2`,
    [pkg.company_id, pkg.category_id]
  );
  if (category && category.status !== "enabled") return "This service is currently unavailable.";
  return null;
}
