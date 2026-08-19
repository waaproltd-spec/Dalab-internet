package com.dalab.internet.data

/**
 * A `reseller_withdrawals` row waiting on an automatic payout — mirrors
 * GET /agent/reseller-withdrawals/pending-payout (admin-backend-ts's
 * resellerDepositsWithdrawals.routes.ts). Only 'reserved' withdrawals with
 * EITHER a configured company payout_ussd_template OR a fully-configured
 * interactivePayout, and no dial attempt yet, are ever returned by that
 * endpoint, so every row here is always actionable — unlike ExchangeOrder's
 * hasDialAttempt flag, there is nothing to filter client-side. Exactly one
 * of payoutUssdTemplate/interactivePayout is non-null for a given row —
 * which orchestrator dials it (ResellerWithdrawalUssdOrchestrator's
 * one-shot dial vs ResellerWithdrawalInteractiveUssdOrchestrator's
 * multi-step reply sequence) is decided by which one is present, see
 * ResellerWithdrawalSelfHealSweeper.
 */
data class ResellerWithdrawalPendingPayout(
    val id: String,             // "WDR..." reference
    val companyId: String,
    val companyName: String,
    val payoutUssdTemplate: String?,   // {number}/{amount} substituted, PIN inlined — see ussd/ResellerWithdrawalUssdOrchestrator.kt
    val destinationNumber: String,
    val customerReceivesAmount: Double, // amount + company bonus — what's actually dialed out, not the raw Wallet amount
    val interactivePayout: ResellerWithdrawalInteractivePayout? = null,
)

/**
 * eDahab-style multi-step payout config for one live withdrawal — mirrors
 * the `interactivePayout` object GET /agent/reseller-withdrawals/pending-payout
 * attaches once both a company's initial_dial/reply_steps AND its PIN are
 * configured (see admin-backend-ts's migration 060 and
 * resellerDepositsWithdrawals.routes.ts). replySteps still contains
 * {number}/{amount} placeholders for
 * ResellerWithdrawalInteractiveUssdOrchestrator to substitute client-side
 * (same substitution ResellerWithdrawalUssdOrchestrator's one-shot template
 * already does) — pin is the one already-decrypted, ready-to-type value,
 * always the LAST reply in the sequence, held only in memory for the
 * seconds it takes to type it (see
 * ResellerWithdrawalInteractiveUssdBridge's own doc comment).
 */
data class ResellerWithdrawalInteractivePayout(
    val initialDial: String,
    val replySteps: List<String>,
    val pin: String,
)

/**
 * Mirrors GET /agent/reseller-withdrawal-sim-routing — Reseller Withdraw's
 * own SIM routing (company -> device + physical slot), separate from
 * ussd/SimRoutingEntry (Internet Store/eBadal recharge's routing). Only
 * active=true routes are ever returned by that endpoint, so every entry
 * here is always usable. mobileNumber is an Admin-entered display/audit
 * label (see migration 058's header comment for why it's not enforceable
 * against the physically inserted SIM) — attached to the dial-attempt log
 * server-side for audit visibility even though it plays no role in the
 * dial itself.
 */
data class ResellerWithdrawalSimRoutingEntry(
    val companyId: String,
    val simSlot: Int, // 1 or 2
    val companyName: String,
    val mobileNumber: String?,
)
