-- sim_balances was UNIQUE(device_id, sim_slot) -- one row per PHYSICAL SIM
-- slot. That's wrong: a single physical SIM can report two genuinely
-- separate balances via two different carrier SMS types from the same
-- number -- confirmed live. Hormuud's Mobile 1/SIM 1 sends both its own
-- Send Data balance ("[-E-Voucher-]... Haraagaagu waa $X", sender 740) and
-- its EVC Plus mobile-money wallet balance ("[-EVCPLUS-]... haraagagu waa
-- $Y", sender 192) -- not the same value reported twice, two different
-- real balances. Under the old constraint, whichever one updated last
-- silently overwrote the other's provider_key on the SAME row, making that
-- provider's dashboard card revert to "Unknown" the moment the other one
-- updated (real incident: an EVC Plus update reset Hormuud's own Send Data
-- row, right after 095's own backfill/fix went live).
--
-- Widened to UNIQUE(device_id, sim_slot, provider_key): now one row per
-- (physical SIM, balance identity) pair. provider_key can still be NULL
-- for a row never resolved through the Sender-ID gate at all (matches
-- existing COALESCE-preserve semantics in applyBalanceUpdate/simBalances.
-- routes.ts) -- Postgres treats NULLs as distinct for uniqueness purposes,
-- so this doesn't block a second NULL-provider_key row from existing, but
-- that's an acceptable rare edge case (a device+slot with zero routing
-- info AND no explicit providerKey), not a regression from before.
DO $$
BEGIN
  ALTER TABLE sim_balances DROP CONSTRAINT sim_balances_device_id_sim_slot_key;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sim_balances_device_slot_provider ON sim_balances (device_id, sim_slot, provider_key);
