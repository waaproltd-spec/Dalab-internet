import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";

/**
 * Records a before/after change to Super-Admin-controlled config (payment
 * gateway numbers/templates, USSD templates) — who changed it, when, and
 * the old/new values, per the Activity Log requirement. Best-effort: a
 * logging failure must never block the actual config change from saving,
 * so callers fire-and-catch this rather than awaiting it inline with the
 * real write's error handling.
 */
export async function recordActivity(params: {
  adminId: string | undefined;
  action: string;
  entityType: string;
  entityId: string;
  oldValue: unknown;
  newValue: unknown;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO admin_activity_log (id, admin_id, action, entity_type, entity_id, old_value, new_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        params.adminId ?? null,
        params.action,
        params.entityType,
        params.entityId,
        JSON.stringify(params.oldValue ?? null),
        JSON.stringify(params.newValue ?? null),
      ]
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to record activity log:", (err as Error).message);
  }
}
