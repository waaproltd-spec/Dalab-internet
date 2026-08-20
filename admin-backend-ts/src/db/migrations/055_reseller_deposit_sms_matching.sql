-- Reseller Deposit automatic SMS matching — mirrors the device/SIM
-- verification already proven for Internet Store (company_payment_methods.
-- device_id/sim_slot, migration 036) and Money Exchange
-- (exchange_payout_wallets), so a Reseller Deposit's incoming payment SMS is
-- verified against the exact same collection-number infrastructure instead
-- of matching by amount+phone alone. Same "not yet linked to a device ->
-- accept and auto-link on first real match" fallback as those two.
ALTER TABLE reseller_deposit_methods ADD COLUMN IF NOT EXISTS device_id TEXT REFERENCES agent_devices(id) ON DELETE SET NULL;
ALTER TABLE reseller_deposit_methods ADD COLUMN IF NOT EXISTS sim_slot INTEGER CHECK (sim_slot IS NULL OR sim_slot IN (1,2));

-- Same role as sms_logs.matched_order_id / matched_exchange_order_id: an
-- O(1) "did this exact SMS already resolve to a Reseller Deposit" check for
-- the dedup/duplicate-delivery guard, and a stable audit trail entry point.
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS matched_reseller_deposit_id TEXT REFERENCES reseller_deposits(id) ON DELETE SET NULL;
