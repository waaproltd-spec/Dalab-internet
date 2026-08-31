-- Fully automatic Withdraw payout: the Agent App now dials the payout USSD
-- itself (no manual dial by Reseller or Agent), the same "TelephonyManager.
-- sendUssdRequest, single combined string" mechanism Internet Store recharge
-- already uses (see UssdOrchestrator.kt/UssdDialer.kt in the Agent App) --
-- reseller_withdrawals.payout_ussd_template is a single one-shot string
-- (number+amount+PIN together), not the two-step interactive flow Money
-- Exchange needs its AccessibilityService for.
--
-- This table is audit/dedup only, mirroring ussd_dial_attempts' full shape
-- (including the masked-PIN column from day one, unlike that table's
-- migration history). It intentionally has NO side effect on
-- reseller_withdrawals.status on its own: unlike Internet Store (where a
-- 'success' dial-attempt report completes the order directly, see
-- PUT /agent/dial-attempts/:attemptId), a Withdrawal only ever reaches
-- 'completed' via the real outgoing SMS confirmation matching it
-- (resellerSmsMatching.ts) or an admin's manual Complete -- sending the USSD
-- command is not proof the money actually moved. Existence of a row here is
-- what the self-heal "pending payout" candidates query checks so a
-- withdrawal is never auto-dialed twice.
CREATE TABLE IF NOT EXISTS reseller_withdrawal_dial_attempts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id     TEXT NOT NULL REFERENCES reseller_withdrawals(id) ON DELETE CASCADE,
  agent_id          UUID REFERENCES agents(id) ON DELETE SET NULL,
  sim_slot          INTEGER,
  ussd_string       TEXT NOT NULL,
  ussd_string_masked TEXT,
  attempt_number    INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed','ambiguous')),
  response_message  TEXT,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reseller_withdrawal_dial_attempts_withdrawal_id ON reseller_withdrawal_dial_attempts(withdrawal_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reseller_withdrawal_dial_attempts_withdrawal_attempt
  ON reseller_withdrawal_dial_attempts(withdrawal_id, attempt_number);
