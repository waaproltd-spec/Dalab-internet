-- sim_balances.last_source / sim_balance_history.source gain 'ussd_dial' --
-- mirrors reseller_wallet_transactions' own 'ussd_dial' source
-- (059_reseller_wallet_ussd_dial_source.sql). Confirmed production gap: a
-- carrier's own USSD dial response can report a SIM's real remaining
-- balance in the same breath as confirming the top-up itself (e.g.
-- Somtel's "...Haraagaagu waa: $28.75."), but until now that figure was
-- only ever captured for display (ussd_dial_attempts.response_message) --
-- nothing fed it into the balance pipeline, which only ever listened to a
-- SEPARATE incoming SMS (extractBalanceFromSms via ingestPaymentSms).
-- Somtel's own confirmation apparently never arrives as a distinct
-- balance-report SMS the way Somnet's does, so its dashboard/Agent App
-- balance went stale indefinitely despite a fresh reading arriving on
-- every single successful dial.
ALTER TABLE sim_balances DROP CONSTRAINT sim_balances_last_source_check;
ALTER TABLE sim_balances ADD CONSTRAINT sim_balances_last_source_check
  CHECK (last_source IN ('sms','manual','ussd_dial'));

ALTER TABLE sim_balance_history DROP CONSTRAINT sim_balance_history_source_check;
ALTER TABLE sim_balance_history ADD CONSTRAINT sim_balance_history_source_check
  CHECK (source IN ('sms','manual','ussd_dial'));
