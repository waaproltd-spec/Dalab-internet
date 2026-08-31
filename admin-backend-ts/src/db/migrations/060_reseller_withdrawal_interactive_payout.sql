-- Interactive (multi-step) USSD payout config, for a payout provider whose
-- carrier menu isn't a single one-shot combined string like Hormuud's
-- payout_ussd_template (`*726*{number}*{amount}*PIN#`). eDahab's own
-- Reseller Service menu is multi-step and interactive instead: dial *300#,
-- reply "3" (Transfer), reply the destination number, reply the amount,
-- then reply the reseller's own PIN once the carrier prompts for it — each
-- reply only valid once the carrier's own prompt for it appears. The Agent
-- App drives this the same way it already drives Money Exchange's two-step
-- PIN flow (ExchangeUssdOrchestrator/AccessibilityService): ACTION_CALL +
-- read/reply to the native USSD dialog, generalized from a single PIN slot
-- to an ordered queue of replies — see
-- ResellerWithdrawalInteractiveUssdOrchestrator (agent-app).
--
-- Separate table from `companies` (mirrors reseller_withdrawal_sim_routing's
-- own reasoning) rather than new columns there, since this is genuinely
-- optional per-company config, not every company's shape.
--
-- reply_steps is the ordered list of replies to send AFTER the initial dial.
-- By default the PIN is NOT included and is implicitly appended as the very
-- last reply once the carrier's own PIN prompt appears (eDahab's flow:
-- Reseller Service -> Transfer -> number -> amount -> PIN) -- this is the
-- original, still-default behavior, unchanged for every company configured
-- this way. A company whose carrier prompts for the PIN somewhere other
-- than last (e.g. Somnet: *825# -> PIN -> "2" -> number -> number -> amount
-- -> "1", where the PIN is the very first reply) instead places an explicit
-- {pin} token in its own replySteps at the right position; when {pin}
-- appears anywhere in replySteps, the PIN is substituted only there and is
-- NOT also appended at the end. The PIN itself is never stored inline in
-- this config (see ExchangeUssdOrchestrator's own PIN handling for why),
-- decrypted fresh from pin_encrypted only when handing a live pending
-- payout to the Agent App (GET /agent/reseller-withdrawals/pending-payout),
-- same trust boundary Hormuud's inlined-PIN payout_ussd_template already
-- has. Each reply_steps entry is either a literal (e.g. "3" for the
-- Transfer menu item) or a template containing {number}, {amount}, and/or
-- {pin}, substituted server-side before the array is ever sent to the
-- device — same substitution Hormuud's one-shot template already does,
-- just per-step instead of once.
--
-- pin_encrypted mirrors exchange_payout_wallets.pin_encrypted exactly:
-- Super-Admin-write-only, AES-256-GCM via auth/crypto.ts's encrypt/decrypt,
-- never returned by any GET (only a boolean pin_is_set flag).
CREATE TABLE IF NOT EXISTS reseller_withdrawal_interactive_payout_config (
  company_id     TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  initial_dial   TEXT NOT NULL,
  reply_steps    JSONB NOT NULL,
  pin_encrypted  TEXT,
  updated_by     UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
