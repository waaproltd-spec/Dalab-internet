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
