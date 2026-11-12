import { query, queryOne } from "../db/pool.js";
import { DEVICE_ONLINE_SQL } from "./deviceStatus.js";

/**
 * Which phone and SIM are responsible for dialing an order -- one answer,
 * used by every dial path (the server's dial-attempt check, the self-heal
 * candidates each phone polls, the dashboard).
 *
 *  1. The order's USSD template pinned a device + SIM (orders.ussd_device_id
 *     / ussd_sim_slot, copied from the template by generateUssdForOrder).
 *  2. Otherwise the company's PRIMARY SIM Routing entry (lowest priority;
 *     ties broken by which was added first, the same order the dashboard
 *     lists them in).
 *
 * Backup routing rows are never used automatically: an order assigned to
 * Mobile 2 · SIM 2 stays with Mobile 2 · SIM 2 when that SIM is offline,
 * has no balance, errors or times out. It waits, or needs a person to
 * verify it. Only an Admin changing the routing (or the template) moves it,
 * and because this is read live, the new assignment applies at once.
 */
export type AssignedRoute = { deviceId: string; simSlot: number; source: "template" | "sim_routing" };

/** SQL fragment ordering sim_routing rows so the first is the primary. */
export const SIM_ROUTING_PRIMARY_ORDER = "priority ASC, updated_at ASC, device_id ASC";

export async function assignedRouteFor(order: {
  company_id: string;
  ussd_device_id?: string | null;
  ussd_sim_slot?: number | null;
}): Promise<AssignedRoute | null> {
  if (order.ussd_device_id && order.ussd_sim_slot) {
    return { deviceId: order.ussd_device_id, simSlot: Number(order.ussd_sim_slot), source: "template" };
  }
  const primary = await queryOne<{ device_id: string; sim_slot: number }>(
    `SELECT device_id, sim_slot FROM sim_routing
      WHERE company_id=$1 AND device_id IS NOT NULL
      ORDER BY ${SIM_ROUTING_PRIMARY_ORDER} LIMIT 1`,
    [order.company_id]
  );
  return primary ? { deviceId: primary.device_id, simSlot: Number(primary.sim_slot), source: "sim_routing" } : null;
}

/** Companies this device is the primary routed device for (company -> slot). */
export async function primaryRoutesForDevice(deviceId: string): Promise<Array<{ companyId: string; simSlot: number; companyName: string }>> {
  return query(
    `SELECT p.company_id AS "companyId", p.sim_slot AS "simSlot", c.name AS "companyName"
       FROM (SELECT DISTINCT ON (company_id) company_id, device_id, sim_slot
               FROM sim_routing WHERE device_id IS NOT NULL
              ORDER BY company_id, ${SIM_ROUTING_PRIMARY_ORDER}) p
       JOIN companies c ON c.id = p.company_id
      WHERE p.device_id = $1`,
    [deviceId]
  );
}

/**
 * Plain-language "why hasn't this been dialed" for the dashboard, from the
 * assigned SIM's own state only -- never from any other device.
 */
export type RouteStatus = {
  assigned: (AssignedRoute & { deviceName: string | null; online: boolean; simPresent: boolean | null; lastHeartbeatAt: string | null }) | null;
  waitingReason: string | null;
};

export async function routeStatusFor(order: {
  company_id: string;
  status: string;
  ussd_device_id?: string | null;
  ussd_sim_slot?: number | null;
}): Promise<RouteStatus> {
  const route = await assignedRouteFor(order);
  if (!route) {
    return { assigned: null, waitingReason: "No SIM assigned — add this company under Device & USSD → SIM Routing." };
  }
  const d = await queryOne<{ name: string; online: boolean; sim1_present: boolean | null; sim2_present: boolean | null; last_heartbeat_at: string | null }>(
    `SELECT d.name, ${DEVICE_ONLINE_SQL} AS online, d.sim1_present, d.sim2_present, d.last_heartbeat_at
       FROM agent_devices d WHERE d.id=$1`,
    [route.deviceId]
  );
  const simPresent = d ? (route.simSlot === 1 ? d.sim1_present : d.sim2_present) : null;
  const label = `${d?.name ?? route.deviceId} · SIM ${route.simSlot}`;
  let waitingReason: string | null = null;
  if (order.status === "in_progress") {
    if (!d) waitingReason = `Waiting for Assigned SIM — device ${route.deviceId} no longer exists; reassign it in SIM Routing.`;
    else if (!d.online) waitingReason = `Waiting for Assigned SIM — ${label} is offline.`;
    else if (simPresent === false) waitingReason = `Waiting for Assigned SIM — ${label} isn't detected in the phone.`;
  }
  return {
    assigned: { ...route, deviceName: d?.name ?? null, online: Boolean(d?.online), simPresent, lastHeartbeatAt: d?.last_heartbeat_at ?? null },
    waitingReason,
  };
}
