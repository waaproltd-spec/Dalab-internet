/**
 * What stops an agent phone from working on its own, from its heartbeat
 * (migration 119 columns). "error" = automation is broken until someone
 * acts; "warning" = it works now but may stop (e.g. Android may kill it).
 * Unknown (NULL, older app) is never reported as a problem or as healthy.
 */
export interface DeviceHealthIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface DeviceHealthRow {
  enabled?: boolean | null;
  last_heartbeat_at?: Date | string | null;
  network_online?: boolean | null;
  sms_permission?: boolean | null;
  phone_permission?: boolean | null;
  pending_sms_count?: number | null;
  oldest_pending_sms_age_sec?: number | string | null;
  accessibility_reseller_enabled?: boolean | null;
  battery_optimization_ignored?: boolean | null;
  notifications_enabled?: boolean | null;
}

export const HEARTBEAT_STALE_MINUTES = 5;
export const PENDING_SMS_STALE_MINUTES = 10;

export function deviceHealthIssues(d: DeviceHealthRow, now: Date = new Date()): DeviceHealthIssue[] {
  if (d.enabled === false) return [];
  const issues: DeviceHealthIssue[] = [];
  const last = d.last_heartbeat_at ? new Date(d.last_heartbeat_at) : null;
  if (!last || now.getTime() - last.getTime() > HEARTBEAT_STALE_MINUTES * 60_000) {
    issues.push({
      code: "offline",
      severity: "error",
      message: last
        ? `No heartbeat for ${Math.round((now.getTime() - last.getTime()) / 60_000)} min — the phone is off, has no internet, or the app was stopped.`
        : "This phone has never sent a heartbeat.",
    });
  } else if (d.network_online === false) {
    issues.push({ code: "no_internet", severity: "error", message: "The phone reports no internet connection." });
  }
  if (d.sms_permission === false) {
    issues.push({ code: "sms_permission", severity: "error", message: "SMS permission is off — payment SMS can't be received. Allow SMS for DALAB Agent in Android Settings." });
  }
  if (d.phone_permission === false) {
    issues.push({ code: "phone_permission", severity: "error", message: "Phone permission is off — USSD can't be dialed. Allow Phone for DALAB Agent in Android Settings." });
  }
  const pending = Number(d.pending_sms_count ?? 0);
  const oldestSec = Number(d.oldest_pending_sms_age_sec ?? 0);
  if (pending > 0 && oldestSec > PENDING_SMS_STALE_MINUTES * 60) {
    issues.push({
      code: "sms_not_uploaded",
      severity: "error",
      message: `${pending} payment SMS saved on the phone haven't reached the server for ${Math.round(oldestSec / 60)} min (it keeps retrying).`,
    });
  }
  if (d.accessibility_reseller_enabled === false) {
    issues.push({
      code: "accessibility",
      severity: "warning",
      message: "Accessibility for DALAB is off — menu USSD (Dhameys Plus, Reseller Withdraw) can't run. Turn it on in Settings > Accessibility.",
    });
  }
  if (d.battery_optimization_ignored === false) {
    issues.push({
      code: "battery_optimization",
      severity: "warning",
      message: "Battery optimisation is on for DALAB — Android may stop it in the background. Set Battery to Unrestricted.",
    });
  }
  if (d.notifications_enabled === false) {
    issues.push({ code: "notifications", severity: "warning", message: "Notifications are off — the agent won't see alerts." });
  }
  return issues;
}
