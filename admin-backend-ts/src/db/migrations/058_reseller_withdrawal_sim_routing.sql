-- Reseller Withdraw's OWN SIM routing — deliberately a separate table from
-- the existing `sim_routing` (Internet Store/eBadal recharge), per product
-- decision, so an Admin can point a company's WITHDRAWAL payouts at a
-- different device/SIM than that same company's RECHARGE orders use (e.g. a
-- dedicated payout line kept flush with balance for reseller withdrawals,
-- independent of the line used for customer top-ups).
--
-- Same underlying shape as sim_routing (company -> device + physical slot,
-- since a real USSD dial can only ever target an actual inserted SIM card —
-- no Android API lets software assign a phone number to a slot), plus two
-- withdrawal-specific additions:
--   mobile_number — an Admin-entered display/audit label for "which real
--     number is this". NOT enforced against whatever SIM is physically
--     inserted (Android exposes no way to verify that programmatically) —
--     keeping it accurate is an operational responsibility, surfaced here
--     purely so Admin/Support can see "SIM 1 = Hormuud = 61xxxxxxx" and so
--     every dial attempt's audit trail can record which real number sent
--     the money, without a Super Admin having to cross-reference a device
--     inventory sheet by hand.
--   active — a per-route kill switch finer-grained than agent_devices.
--     enabled's whole-device toggle: disabling THIS route stops Reseller
--     Withdraw payouts for this company without disabling the device for
--     Internet Store/Money Exchange, which may still be routed through it.
CREATE TABLE IF NOT EXISTS reseller_withdrawal_sim_routing (
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  device_id      TEXT REFERENCES agent_devices(id) ON DELETE SET NULL,
  sim_slot       INTEGER NOT NULL CHECK (sim_slot IN (1,2)),
  mobile_number  TEXT,
  active         BOOLEAN NOT NULL DEFAULT true,
  priority       INTEGER NOT NULL DEFAULT 1,
  updated_by     UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, device_id)
);

-- Audit trail (product requirement: "Admin can see exactly which SIM sent
-- the money" for every dial attempt) — snapshotted onto the attempt row at
-- dial time, same "don't mutate history" principle as
-- reseller_withdrawals.commission_percentage: a later Admin edit to the
-- route (a new mobile number, a different device) must never rewrite what
-- an already-made attempt actually used.
ALTER TABLE reseller_withdrawal_dial_attempts ADD COLUMN IF NOT EXISTS sim_device_id TEXT;
ALTER TABLE reseller_withdrawal_dial_attempts ADD COLUMN IF NOT EXISTS sim_mobile_number TEXT;
