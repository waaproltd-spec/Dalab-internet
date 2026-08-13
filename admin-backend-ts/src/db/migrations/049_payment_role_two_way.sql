-- Collapses the payment_role choice from three options down to two:
-- receive_only or send_only, full stop. The "Send + Receive" middle
-- ground let a device silently do both, which is exactly how mobile-1
-- ended up mislabeled send_only while it was actually the phone handling
-- most real incoming Hormuud payments and a chunk of outgoing USSD sends
-- at once — nothing forced an explicit choice. Every device must now be
-- one or the other so payment routing is never ambiguous about which
-- phone is responsible for what.
--
-- Any device still carrying the old 'send_receive' value is converted to
-- 'send_only' as the conservative fallback (never silently start crediting
-- incoming money on a device nobody vetted as the receiver) — but this
-- should be a no-op in practice: operators are expected to explicitly
-- reclassify every real dual-role device (e.g. via
-- UPDATE agent_devices SET payment_role='receive_only' WHERE id=...)
-- before this migration runs, so nothing they actually rely on for
-- receiving silently flips to send_only here.
UPDATE agent_devices SET payment_role = 'send_only' WHERE payment_role = 'send_receive';

ALTER TABLE agent_devices ALTER COLUMN payment_role SET DEFAULT 'send_only';

ALTER TABLE agent_devices DROP CONSTRAINT IF EXISTS agent_devices_payment_role_check;
ALTER TABLE agent_devices ADD CONSTRAINT agent_devices_payment_role_check
  CHECK (payment_role IN ('receive_only', 'send_only'));
