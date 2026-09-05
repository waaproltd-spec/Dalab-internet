-- Balance Dashboard: 6 separately-displayed balances (EVC Plus, eDahab,
-- Hormuud/Somtel/Amtel/Somnet Send Data), not just the 4 companies.
-- sim_balances.company_id alone can't tell these apart -- a company's own
-- top-up SIM and its EVC Plus/eDahab collection SIM (a different physical
-- SIM, company_payment_methods.device_id/sim_slot, 036) both carry the same
-- company_id, since company_id is a FK to `companies` and EVC Plus/eDahab
-- aren't rows in that table. provider_key is the exact 6-way identity
-- resolveBalanceProvider() (simBalances.ts) already computes on every
-- balance SMS -- one of 'hormuud','somtel','somnet','amtel','evc_plus',
-- 'edahab' -- now persisted instead of discarded after the Sender-ID gate
-- check.
--
-- Nullable and unconstrained by a FK (unlike company_id): a SIM that's
-- never had a balance update resolved through resolveBalanceProvider() yet
-- (e.g. only ever manually assigned a company via the old metadata-only
-- upsert) has no known provider_key, and must render as such rather than
-- guessing. No CHECK constraint against the 6 literals either, so this
-- column can't ever block an insert/update the same way a bad company_id
-- FK could -- worst case an unrecognized value just falls into the
-- dashboard's "unassigned" bucket, exactly like a NULL would.
ALTER TABLE sim_balances ADD COLUMN IF NOT EXISTS provider_key TEXT;

-- Backfill: every EXISTING row today is a company's own top-up SIM (EVC
-- Plus/eDahab collection SIMs were never persisted as such before this
-- migration, since the column didn't exist) -- company_id IS the correct
-- provider_key for all of them. This is a one-time data fix on existing
-- rows, not new runtime logic; nothing here touches sim_routing,
-- company_payment_methods, or any USSD/payment/order table.
UPDATE sim_balances SET provider_key = company_id WHERE provider_key IS NULL AND company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sim_balances_provider_key ON sim_balances(provider_key);
