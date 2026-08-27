-- Balance Dashboard fix: sim_balances.balance defaulted to 0 and disallowed
-- NULL, so a SIM that has NEVER received a real balance update (SMS or
-- manual) was indistinguishable from one genuinely confirmed at $0 -- both
-- rendered as "$0.00". Dropping the default/NOT NULL lets "no real balance
-- known yet" be represented honestly as NULL, which the dashboard now
-- renders as "Unknown"/"No recent balance" instead of inventing a number.
ALTER TABLE sim_balances ALTER COLUMN balance DROP DEFAULT;
ALTER TABLE sim_balances ALTER COLUMN balance DROP NOT NULL;

-- Real carrier balance SMS report a third decimal (confirmed live: EVC
-- Plus's own "haraagagu waa $2.965") -- NUMERIC(12,2) silently rounded that
-- to $2.97/$2.96, which is itself a form of "not the actual latest SMS
-- balance". Widening to 3 decimals (and matching sim_balance_history's
-- audit columns, so previous/new/change amounts stay exact too) loses no
-- existing data -- 2-decimal values are unaffected.
ALTER TABLE sim_balances ALTER COLUMN balance TYPE NUMERIC(12,3);
ALTER TABLE sim_balances ALTER COLUMN low_balance_threshold TYPE NUMERIC(12,3);
ALTER TABLE sim_balance_history ALTER COLUMN previous_balance TYPE NUMERIC(12,3);
ALTER TABLE sim_balance_history ALTER COLUMN new_balance TYPE NUMERIC(12,3);
ALTER TABLE sim_balance_history ALTER COLUMN change_amount TYPE NUMERIC(12,3);

-- Denormalized copy of the most recent sim_balance_history entry's
-- source/sms_log_id directly onto the current-value row, so the dashboard
-- can show "via SMS" vs "manual override" on each provider card/row without
-- an extra join into history -- full audit trail (previous/new balance,
-- change amount, timestamp) still lives in sim_balance_history unchanged.
ALTER TABLE sim_balances ADD COLUMN IF NOT EXISTS last_source TEXT CHECK (last_source IN ('sms','manual'));
ALTER TABLE sim_balances ADD COLUMN IF NOT EXISTS last_sms_log_id UUID REFERENCES sms_logs(id) ON DELETE SET NULL;

-- Existing rows: a balance of exactly 0 with no history at all is
-- indistinguishable from "never really updated" (the old metadata-only
-- upsert in PUT /admin/sim-balances/:deviceId/:simSlot always wrote 0 as a
-- placeholder when only assigning company/phone) -- revert those specific
-- rows to genuinely unknown rather than leaving a fake "$0.00" behind. A
-- row with real history (any sim_balance_history entry) keeps its balance
-- and gets backfilled last_source/last_sms_log_id from its most recent
-- history entry, exactly what a real SMS/manual update would have set.
UPDATE sim_balances sb
SET balance = NULL
WHERE balance = 0
  AND NOT EXISTS (SELECT 1 FROM sim_balance_history h WHERE h.sim_balance_id = sb.id);

UPDATE sim_balances sb
SET last_source = latest.source, last_sms_log_id = latest.sms_log_id
FROM (
  SELECT DISTINCT ON (sim_balance_id) sim_balance_id, source, sms_log_id
  FROM sim_balance_history
  ORDER BY sim_balance_id, created_at DESC
) AS latest
WHERE sb.id = latest.sim_balance_id;
