-- Adds 'ambiguous' to ussd_dial_attempts.status: previously only
-- 'pending'/'success'/'failed' existed, and Android's USSD callback
-- (UssdDialer.kt) treated ANY response text from the carrier as 'success'
-- regardless of what it said — a response reading like a failure/timeout/
-- error was indistinguishable, at the code level, from a genuine top-up
-- confirmation, and both completed the order the same way. 'ambiguous'
-- is reported when the response text itself doesn't read like a
-- confirmation (see UssdDialer.looksLikeFailureResponse); it is recorded
-- with the raw carrier text for visibility, same as 'failed', but is
-- deliberately excluded from the order-completion branch in
-- ussd.routes.ts so it can never silently complete an order.
ALTER TABLE ussd_dial_attempts DROP CONSTRAINT IF EXISTS ussd_dial_attempts_status_check;
ALTER TABLE ussd_dial_attempts ADD CONSTRAINT ussd_dial_attempts_status_check
  CHECK (status IN ('pending', 'success', 'failed', 'ambiguous'));
