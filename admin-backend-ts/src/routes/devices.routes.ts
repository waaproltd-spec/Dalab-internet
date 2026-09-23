import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";

// Trusted Devices (Account -> Security -> Trusted Devices in the Customer
// App) -- read/remove side. See services/deviceTracking.ts for how a row
// here gets created/updated in the first place (a side effect of a
// successful login, not a route of its own).
export const devicesRouter = Router();

const DEVICE_COLUMNS = "id, device_id, device_name, device_type, platform, os_version, app_version, location, first_seen_at, last_active_at";

devicesRouter.get("/customer/devices", requireAuth("customer"), async (req, res) => {
  const rows = await query(
    `SELECT ${DEVICE_COLUMNS} FROM customer_devices WHERE customer_id=$1 AND revoked_at IS NULL ORDER BY last_active_at DESC`,
    [req.auth!.sub]
  );
  sendJson(res, 200, rows);
});

devicesRouter.get("/customer/devices/:id", requireAuth("customer"), async (req, res) => {
  const device = await queryOne(
    `SELECT ${DEVICE_COLUMNS} FROM customer_devices WHERE id=$1 AND customer_id=$2 AND revoked_at IS NULL`,
    [req.params.id, req.auth!.sub]
  );
  if (!device) return sendJson(res, 404, { error: "Device not found" });

  const activity = await query(
    `SELECT id, type, created_at FROM customer_device_activity WHERE device_id=$1 ORDER BY created_at DESC LIMIT 10`,
    [req.params.id]
  );
  sendJson(res, 200, { ...device, recentActivity: activity });
});

// A device can be sent here by its OWN customer only (the id must belong to
// req.auth's own subject) -- removing it revokes every refresh token this
// device is currently holding (see /auth/refresh's own device_id check,
// which is what actually turns "removed here" into "signed out on that
// device" the next time it tries to refresh -- immediately, if it's the
// device making this exact request). Never a hard DELETE: revoked_at keeps
// the row (and its activity history) around instead of silently vanishing
// it, same "soft revoke, not delete" pattern refresh_tokens.revoked itself
// already uses.
devicesRouter.delete("/customer/devices/:id", requireAuth("customer"), async (req, res) => {
  const device = await queryOne<{ id: string; device_id: string }>(
    `SELECT id, device_id FROM customer_devices WHERE id=$1 AND customer_id=$2 AND revoked_at IS NULL`,
    [req.params.id, req.auth!.sub]
  );
  if (!device) return sendJson(res, 404, { error: "Device not found" });

  await query(`UPDATE customer_devices SET revoked_at=now() WHERE id=$1`, [device.id]);
  await query(`INSERT INTO customer_device_activity (device_id, type) VALUES ($1,'removed')`, [device.id]);
  await query(
    `UPDATE refresh_tokens SET revoked=true WHERE subject_id=$1 AND subject_role='customer' AND device_id=$2`,
    [req.auth!.sub, device.device_id]
  );
  sendJson(res, 200, { removed: true });
});

// Called once per app open (best-effort, silent on failure) -- refreshes
// last_active_at and logs an 'app_open' activity row for whichever device
// the caller says it is. A request for a device_id this customer doesn't
// have on file yet (e.g. this exact login call's own registerCustomer
// DeviceLogin() hasn't run/committed yet in a rare race) is just a no-op,
// never an error -- there's nothing here worth surfacing to the customer.
devicesRouter.post("/customer/devices/touch", requireAuth("customer"), async (req, res) => {
  const deviceId = String(req.body.deviceId ?? "").trim();
  if (!deviceId) return sendJson(res, 200, { ok: true });

  const device = await queryOne<{ id: string }>(
    `SELECT id FROM customer_devices WHERE customer_id=$1 AND device_id=$2 AND revoked_at IS NULL`,
    [req.auth!.sub, deviceId]
  );
  if (device) {
    await query(`UPDATE customer_devices SET last_active_at=now() WHERE id=$1`, [device.id]);
    await query(`INSERT INTO customer_device_activity (device_id, type) VALUES ($1,'app_open')`, [device.id]);
  }
  sendJson(res, 200, { ok: true });
});
