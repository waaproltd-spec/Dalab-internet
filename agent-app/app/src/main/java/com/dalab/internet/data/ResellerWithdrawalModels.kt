package com.dalab.internet.data

/**
 * A `reseller_withdrawals` row waiting on an automatic payout — mirrors
 * GET /agent/reseller-withdrawals/pending-payout (admin-backend-ts's
 * resellerDepositsWithdrawals.routes.ts). Only 'reserved' withdrawals with a
 * configured company payout_ussd_template and no dial attempt yet are ever
 * returned by that endpoint, so every row here is always actionable —
 * unlike ExchangeOrder's hasDialAttempt flag, there is nothing to filter
 * client-side.
 */
data class ResellerWithdrawalPendingPayout(
    val id: String,             // "WDR..." reference
    val companyId: String,
    val companyName: String,
    val payoutUssdTemplate: String,   // {number}/{amount} substituted, PIN inlined — see ussd/ResellerWithdrawalUssdOrchestrator.kt
    val destinationNumber: String,
    val customerReceivesAmount: Double, // amount + company bonus — what's actually dialed out, not the raw Wallet amount
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
