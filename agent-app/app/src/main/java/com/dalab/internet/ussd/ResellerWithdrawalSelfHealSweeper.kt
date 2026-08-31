package com.dalab.internet.ussd

import android.content.Context
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.queue.RetryClassifier
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The automatic trigger for Reseller Withdraw payouts: a withdrawal the
 * customer just requested (status 'reserved') is dialed with no agent or
 * reseller action required. Mirrors [SelfHealSweeper]/[ExchangeSelfHealSweeper]'s
 * exact shape (same event-triggered + periodic backstop pattern, same
 * same-device in-flight de-dupe) — completely independent of Internet
 * Store's and Money Exchange's own queues/orchestrators.
 *
 * Duplicate-payout safety (belt and suspenders):
 *  - GET /agent/reseller-withdrawals/pending-payout already excludes any
 *    withdrawal that has ANY dial attempt — success, failure, or ambiguous
 *    — so a failed/ambiguous automated attempt is never silently retried;
 *    it stays 'reserved' (or 'sent', from the failed attempt's own
 *    best-effort bookkeeping bump) for an admin's manual mark-sent/Complete.
 *    This is the check that actually matters for "don't send the money
 *    twice automatically."
 *  - [ResellerWithdrawalUssdOrchestrator.processPendingPayout] itself still
 *    holds its own same-process in-flight guard, and the backend's
 *    dial-attempts endpoint has a UNIQUE(withdrawal_id, attempt_number)
 *    constraint — a genuinely concurrent duplicate call from two different
 *    devices can insert only once.
 *  - Completing the withdrawal (and touching the Wallet) is never this
 *    sweeper's or the orchestrator's job at all — only the real outgoing
 *    SMS match (or an admin's manual Complete) does that, so even a
 *    same-order-twice-dialed edge case can't double-deduct on its own.
 */
object ResellerWithdrawalSelfHealSweeper {
    private val mutex = Mutex()
    private val inFlight = mutableSetOf<String>()

    suspend fun sweep(context: Context) {
        val candidates = try {
            RetryClassifier.requireSuccessful(ApiClient.service.getResellerWithdrawalsPendingPayout()).body().orEmpty()
        } catch (e: Exception) {
            DiagnosticsLog.record("reseller_withdrawal_self_heal_sweep", "Could not fetch pending payouts: ${e.message}", isError = false)
            return
        }
        if (candidates.isEmpty()) return

        val oneShotOrchestrator = ResellerWithdrawalUssdOrchestrator(context)
        val interactiveOrchestrator = ResellerWithdrawalInteractiveUssdOrchestrator(context)
        // Sequential, not parallel — same reasoning as ExchangeSelfHealSweeper:
        // this device only has so many SIMs, and dialing two payouts at once
        // risks one dial's response being misread as the other's.
        for (withdrawal in candidates) {
            val claimed = mutex.withLock {
                if (withdrawal.id in inFlight) false else { inFlight.add(withdrawal.id); true }
            }
            if (!claimed) continue
            try {
                DiagnosticsLog.record("reseller_withdrawal_self_heal_sweep", "Auto-dialing withdrawal ${withdrawal.id} (${withdrawal.companyName}).", isError = false)
                // Exactly one of payoutUssdTemplate/interactivePayout is ever
                // set per row (see ResellerWithdrawalPendingPayout's own doc
                // comment) — which one decides whether this is Hormuud's
                // one-shot dial or eDahab's multi-step reply sequence.
                val result = if (withdrawal.interactivePayout != null) {
                    interactiveOrchestrator.processPendingPayout(withdrawal)
                } else {
                    oneShotOrchestrator.processPendingPayout(withdrawal)
                }
                DiagnosticsLog.record(
                    "reseller_withdrawal_self_heal_sweep",
                    "Withdrawal ${withdrawal.id} (${withdrawal.companyName}) auto-payout result: ${result.outcome}${result.responseMessage?.let { " — $it" } ?: ""}",
                    isError = result.outcome != DialOutcome.SUCCESS && result.outcome != DialOutcome.DUPLICATE_SKIPPED,
                )
            } catch (e: Exception) {
                DiagnosticsLog.record("reseller_withdrawal_self_heal_sweep", "Withdrawal ${withdrawal.id} auto-payout threw: ${e.stackTraceToString().take(2000)}")
            } finally {
                mutex.withLock { inFlight.remove(withdrawal.id) }
            }
        }
    }
}
