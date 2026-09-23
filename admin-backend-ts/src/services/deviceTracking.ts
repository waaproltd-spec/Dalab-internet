// Trusted Devices' write side -- called as a best-effort side effect of a
// successful customer login/signup (see auth.routes.ts) and never throws,
// so a device-tracking failure can never fail the login itself. Reading
// the list back (GET /customer/devices) and removing one (DELETE) live in
// devices.routes.ts.

import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { notifyCustomer } from "./customerNotify.js";

export interface DeviceInfo {
  deviceId: string;
  deviceName?: string;
  deviceType?: string;
  platform?: string;
  osVersion?: string;
  appVersion?: string;
}

/** The Customer App sends an optional `device` object on every login/
 * signup call (see dalab_api.dart's _deviceInfoPayload) -- absent entirely
 * on an old/not-yet-updated app build, in which case this whole feature is
 * simply a no-op for that request, same as before it existed. */
export function parseDeviceInfo(raw: unknown): DeviceInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const deviceId = typeof d.deviceId === "string" ? d.deviceId.trim() : "";
  if (!deviceId) return null;
  const str = (key: string) => (typeof d[key] === "string" && (d[key] as string).trim() ? (d[key] as string).trim() : undefined);
  return {
    deviceId,
    deviceName: str("deviceName"),
    deviceType: str("deviceType"),
    platform: str("platform"),
    osVersion: str("osVersion"),
    appVersion: str("appVersion"),
  };
}

/** Upserts this customer+device pair, logs a 'login' activity row, and --
 * only the first time this exact device_id is ever seen for this customer
 * AND the customer already had at least one other device on file (so this
 * isn't just "their very first device, right after creating the account")
 * -- sends the "signed in from a new device" notification (spec: "Notify
 * the customer when a new device signs in"). */
export async function registerCustomerDeviceLogin(customerId: string, info: DeviceInfo | null): Promise<void> {
  if (!info) return;
  try {
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM customer_devices WHERE customer_id=$1 AND device_id=$2`,
      [customerId, info.deviceId]
    );
    const hadAnyOtherDevice = existing
      ? false
      : Boolean(await queryOne(`SELECT id FROM customer_devices WHERE customer_id=$1 LIMIT 1`, [customerId]));

    let deviceRowId: string;
    if (existing) {
      deviceRowId = existing.id;
      await query(
        `UPDATE customer_devices
         SET last_active_at=now(), revoked_at=NULL, device_name=$1, device_type=$2, platform=$3, os_version=$4, app_version=$5
         WHERE id=$6`,
        [info.deviceName ?? "Unknown Device", info.deviceType ?? "unknown", info.platform ?? "unknown", info.osVersion ?? null, info.appVersion ?? null, deviceRowId]
      );
    } else {
      deviceRowId = randomUUID();
      await query(
        `INSERT INTO customer_devices (id, customer_id, device_id, device_name, device_type, platform, os_version, app_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [deviceRowId, customerId, info.deviceId, info.deviceName ?? "Unknown Device", info.deviceType ?? "unknown", info.platform ?? "unknown", info.osVersion ?? null, info.appVersion ?? null]
      );
    }
    await query(`INSERT INTO customer_device_activity (id, device_id, type) VALUES ($1,$2,'login')`, [randomUUID(), deviceRowId]);

    if (!existing && hadAnyOtherDevice) {
      await notifyCustomer(
        customerId,
        "new_device_login",
        "New device signed in",
        `Your DALAB account was just signed into from ${info.deviceName ?? "a new device"}. If this wasn't you, remove it from Account -> Security -> Trusted Devices.`,
        { deviceId: info.deviceId }
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("registerCustomerDeviceLogin failed:", (err as Error).message);
  }
}
