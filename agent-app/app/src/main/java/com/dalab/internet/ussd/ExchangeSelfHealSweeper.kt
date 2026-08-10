package com.dalab.internet.ussd

import android.content.Context
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.queue.RetryClassifier
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The automatic trigger for Money Exchange payouts: an order the backend
 * has already verified (pending -> in_progress, either by an admin tapping
 * Verify Payment or — now — automatically the moment a matching payment SMS
 * arrives, see admin-backend-ts's autoAdvanceExchangeOrderToInProgress) is
 * dialed with no agent action required. Mirrors [SelfHealSweeper]'s exact
 * shape (same event-triggered + periodic backstop pattern, same same-device
 * in-flight de-dupe), but for Money Exchange's own queue and orchestrator —
 * completely independent of Internet Store's pipeline, same posture as
 * every other Exchange* file in this package.
 *
 * Duplicate-payout safety (belt and suspenders):
 *  - `hasDialAttempt` (server-computed EXISTS over exchange_dial_attempts)
 *    skips any order that already has ONE — success, failure, or ambiguous
 *    — so a failed/ambiguous automated attempt is never silently retried;
 *    it just stays Failed for a human to act on via the manual payout
 *    button in ExchangeOrderDetailScreen. This is the check that actually
 *    matters for "don't send the money twice automatically."
 *  - [ExchangeUssdOrchestrator.executePayout] itself still holds its own
 *    same-process in-flight guard (two overlapping sweep passes can't both
 *    dial the same order), and the backend's dial-attempts endpoint has a
 *    UNIQUE(exchange_order_id, attempt_number) constraint — a genuinely
 *    concurrent duplicate call from two different devices can insert only
 *    once and only the winner ever receives the real PIN.
 */
object ExchangeSelfHealSweeper {
    private val mutex = Mutex()
    private val inFlight = mutableSetOf<String>()

    suspend fun sweep(context: Context) {
        val candidates = try {
            RetryClassifier.requireSuccessful(ApiClient.service.getExchangeOrders()).body().orEmpty()
        } catch (e: Exception) {
            DiagnosticsLog.record("exchange_self_heal_sweep", "Could not fetch exchange orders: ${e.message}", isError = false)
            return
        }
        val payable = candidates.filter { !it.hasDialAttempt }
        if (payable.isEmpty()) return

        val orchestrator = ExchangeUssdOrchestrator(context)
        // Sequential, not parallel — this device only has so many SIMs, and
        // the accessibility service watches one foreground USSD dialog at a
        // time; dialing two exchange payouts concurrently would have one
        // orchestrator's PIN injection racing the other's dialog-reading.
        for (order in payable) {
            val claimed = mutex.withLock {
                if (order.id in inFlight) false else { inFlight.add(order.id); true }
            }
            if (!claimed) continue
            // Same "From → To" fallback pattern already used in
            // ExchangeOrdersListScreen — included here purely so a live
            // failure's provider (e.g. EVC Plus vs eDahab) is visible
            // straight from the log line, with no change to what's dialed
            // or how.
            val corridor = "${order.fromWalletName ?: order.fromWalletId} → ${order.toWalletName ?: order.toWalletId}"
            try {
                DiagnosticsLog.record("exchange_self_heal_sweep", "Auto-dialing exchange order ${order.id} ($corridor).", isError = false)
                val result = orchestrator.executePayout(order)
                DiagnosticsLog.record(
                    "exchange_self_heal_sweep",
                    "Exchange order ${order.id} ($corridor) auto-payout result: ${result.outcome}${result.message?.let { " — $it" } ?: ""}",
                    isError = result.outcome != ExchangeDialOutcome.SUCCESS && result.outcome != ExchangeDialOutcome.DUPLICATE_SKIPPED,
                )
            } catch (e: Exception) {
                DiagnosticsLog.record("exchange_self_heal_sweep", "Order ${order.id} auto-payout threw: ${e.stackTraceToString().take(2000)}")
            } finally {
                mutex.withLock { inFlight.remove(order.id) }
            }
        }
    }
}
