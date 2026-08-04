/**
 * Single source of truth for "is this Agent device actually online right
 * now" — enabled AND self-reporting network connectivity AND a heartbeat
 * received recently. Previously computed three different, inconsistent ways
 * across the backend (GET /admin/agent-devices returned no computed field
 * at all, classifyStuckReason and GET /admin/orders/:id/delivery-status
 * only checked heartbeat recency and ignored enabled/network_online) —
 * which is how a device could show "Online" on one screen and "no
 * heartbeat" on another for the very same row at the same time.
 *
 * Assumes the agent_devices table is aliased as `d` in the surrounding
 * query.
 */
export const DEVICE_ONLINE_SQL =
  `(d.enabled AND d.network_online AND d.last_heartbeat_at > now() - interval '5 minutes')`;
