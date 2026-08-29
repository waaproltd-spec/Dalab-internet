-- Atomic dedup for Offline Auto-Order's own order creation
-- (offlineAutoOrder.ts's matchOrCreateOfflineAutoOrder). The existing
-- sms_logs.transaction_ref unique index (011_payment_dedup_hardening.sql)
-- only prevents a second sms_logs row from claiming the same reference --
-- it does nothing to stop matchOrCreateOfflineAutoOrder's own INSERT INTO
-- orders from running twice for two truly concurrent calls carrying the
-- identical reference (documented as an accepted narrow risk in that
-- function's own comment: "at worst it leaves a second, harmless 'pending'
-- order"). This closes that gap at the database level, the same pattern
-- 005_idempotency_and_dedup.sql already uses for client_request_id: the
-- effective reference (a real carrier transactionRef, or the deterministic
-- Hormuud EVC Plus fallback key computed from stable SMS fields when no
-- real one exists) can never create two orders, racing or not.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS offline_auto_dedup_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_offline_auto_dedup_key
  ON orders (offline_auto_dedup_key) WHERE offline_auto_dedup_key IS NOT NULL;
