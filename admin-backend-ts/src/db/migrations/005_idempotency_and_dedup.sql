-- DALAB INTERNET — duplicate-prevention hardening
-- Adds: a client-supplied idempotency key for order creation (so a retried
-- create — including from the new offline queue — never creates a second
-- order), a natural-key uniqueness guard on dial-attempt audit rows, and a
-- kind column on the Macaash ledger so an earn and a reversal each get their
-- own partial unique index. Applied after 004_device_health_and_failover.sql
-- via `npm run migrate` — every statement is safe to re-run.

-- Order creation idempotency: the client generates one UUID per creation
-- attempt and resends the same value on every retry. NULL (an older client,
-- or an admin-triggered path that doesn't send one) is unrestricted — the
-- partial index only enforces uniqueness where a value is actually present.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_request_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_request_id
  ON orders (client_request_id) WHERE client_request_id IS NOT NULL;

-- Dial-attempt dedup: the natural key for one logical attempt is
-- (order_id, attempt_number) — a queued audit-log POST retried after a
-- dropped response must upsert onto the same row, not create a second one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ussd_dial_attempts_order_attempt
  ON ussd_dial_attempts (order_id, attempt_number);

-- Macaash ledger: distinguish an earn from a reversal row so a partial
-- unique index can backstop the earn/reversal race even if the app-level
-- status guard on orders is ever bypassed (defense in depth, same spirit as
-- idx_sms_logs_dedup). Existing rows are unambiguous from their sign alone
-- (only positive "earn" and negative "reversal" rows have ever been
-- inserted), so the backfill is safe.
ALTER TABLE macaash_transactions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'earn'
  CHECK (kind IN ('earn', 'reversal', 'manual'));
UPDATE macaash_transactions SET kind = 'reversal' WHERE points < 0 AND kind = 'earn';

-- 'manual' (a future non-order-linked adjustment) has no order_id and is
-- exempt from both partial indexes below.
CREATE UNIQUE INDEX IF NOT EXISTS idx_macaash_tx_order_earn
  ON macaash_transactions (order_id) WHERE kind = 'earn' AND order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_macaash_tx_order_reversal
  ON macaash_transactions (order_id) WHERE kind = 'reversal' AND order_id IS NOT NULL;
