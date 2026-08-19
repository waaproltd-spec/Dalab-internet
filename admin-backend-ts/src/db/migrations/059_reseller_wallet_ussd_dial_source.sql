-- reseller_wallet_transactions.source gains 'ussd_dial' — the Agent App's
-- USSD dial result is now the PRIMARY signal that completes a Reseller
-- Withdrawal and debits the wallet (see completeResellerWithdrawalFromDialResult
-- in resellerDepositsWithdrawals.routes.ts), not just the confirmation SMS
-- ('sms') or an admin's manual Complete ('admin_manual'). Real production
-- evidence for the change: several same-amount, same-destination
-- withdrawals can be in flight for one reseller at once, and the SMS
-- matcher's FIFO-by-creation-time pairing always resolves the OLDEST one,
-- leaving a newer, otherwise-identical withdrawal stuck indefinitely
-- waiting on a confirmation SMS that will never specifically match it.
ALTER TABLE reseller_wallet_transactions DROP CONSTRAINT reseller_wallet_transactions_source_check;
ALTER TABLE reseller_wallet_transactions ADD CONSTRAINT reseller_wallet_transactions_source_check
  CHECK (source IN ('sms','admin_manual','system','ussd_dial'));
