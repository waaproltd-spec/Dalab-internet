-- Admin > Mobile Management: which side of the payment flow a given
-- agent_devices row (a physical agent phone/SIM) is allowed to handle.
--   receive_only  - reads incoming payment SMS, never dials USSD to send.
--   send_only     - dials USSD (Internet Store top-ups, Money Exchange
--                   payouts), never uploads/acts on incoming payment SMS.
--   send_receive  - both, same as every device's behavior today.
-- Defaults to send_receive so every existing device keeps working exactly
-- as before this column existed — this is an opt-in restriction, not a
-- new requirement. Enforced server-side in ussd.routes.ts (dial-attempts),
-- exchange.routes.ts (payout dial-attempts), and smsLogs.routes.ts
-- (payment SMS upload); the Agent App also reads it to avoid attempting
-- actions it already knows will be rejected.
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS payment_role TEXT NOT NULL DEFAULT 'send_receive'
  CHECK (payment_role IN ('receive_only', 'send_only', 'send_receive'));
