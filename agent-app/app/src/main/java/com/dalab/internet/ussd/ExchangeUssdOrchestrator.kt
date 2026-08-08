package com.dalab.internet.ussd

import android.content.Context
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.ExchangeDialAttemptStartRequest
import com.dalab.internet.network.ExchangeStepRequest
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The automated Money Exchange payout engine: dial the carrier's two-step
 * USSD flow (number+amount, wait for the carrier's prompt, then the PIN) and
 * report each step back to the backend. Completely independent of
 * UssdOrchestrator (Internet Store) — different dial primitive
 * (ExchangeUssdDialer, not UssdDialer), different backend endpoints,
 * different retry posture (v1: one attempt, no blind retries — a failed or
 * ambiguous automated attempt surfaces a manual fallback in
 * ExchangeOrderDetailScreen instead of silently redialing a live-money PIN
 * flow).
 *
 * PIN handling: the PIN arrives once, in memory, from
 * startExchangeDialAttempt's response — held only in a local `val` for the
 * lifetime of this one payout call, handed to ExchangeUssdBridge purely to
 * pass to the accessibility service, and never logged, stored, or included
 * in any diagnostics/report call. See exchange.routes.ts (backend) for the
 * matching server-side handling.
 */
class ExchangeUssdOrchestrator(private val context: Context) {
    private val dialer = ExchangeUssdDialer(context)

    suspend fun executePayout(order: com.dalab.internet.data.ExchangeOrder): ExchangeDialResult {
        if (!claim(order.id)) {
            return ExchangeDialResult(ExchangeDialOutcome.DUPLICATE_SKIPPED, "Already being processed on this device — skipped to avoid a duplicate payout.")
        }
        try {
            return executeLocked(order)
        } finally {
            release(order.id)
        }
    }

    private suspend fun executeLocked(order: com.dalab.internet.data.ExchangeOrder): ExchangeDialResult {
        // DIAGNOSTIC BUILD — DO NOT MERGE: accessibility gate skipped so
        // Step 1 dials for real regardless of the toggle's state (see
        // below for why that's safe here).
        if (!dialer.hasRequiredPermissions()) {
            return ExchangeDialResult(ExchangeDialOutcome.PERMISSION_DENIED, "Phone permissions aren't granted — check Settings > Apps > Dalab Agent > Permissions.")
        }

        val start = try {
            ApiClient.service.startExchangeDialAttempt(order.id, ExchangeDialAttemptStartRequest(1))
        } catch (e: Exception) {
            DiagnosticsLog.record("exchange_dial_start", "Could not reach server (order ${order.id}): ${e.message}")
            return ExchangeDialResult(ExchangeDialOutcome.NETWORK_UNAVAILABLE, "Could not reach server to start the payout: ${e.message}")
        }
        val body = start.body()
        if (!start.isSuccessful || body == null) {
            return ExchangeDialResult(ExchangeDialOutcome.STEP1_FAILED, "Could not start payout — check the order's status on the dashboard.")
        }
        val pin = body.pin
        if (pin == null) {
            return ExchangeDialResult(ExchangeDialOutcome.STEP1_FAILED, "No PIN available for this payout wallet — ask a Super Admin to check the corridor's payout wallet configuration.")
        }

        val slot = body.simSlot ?: 1
        val subscriptionLookup = dialer.subscriptionIdForSlot(slot)
        val subscriptionId = when (subscriptionLookup) {
            SubscriptionLookupResult.PermissionMissing -> return ExchangeDialResult(ExchangeDialOutcome.PERMISSION_DENIED, "Required phone permissions aren't granted on this device.")
            SubscriptionLookupResult.NotPresent -> return ExchangeDialResult(ExchangeDialOutcome.NO_SIM_PRESENT, "SIM $slot isn't physically inserted on this device.")
            is SubscriptionLookupResult.Found -> subscriptionLookup.subscriptionId
        }

        // DIAGNOSTIC BUILD — DO NOT MERGE: places the real Step 1 call (so
        // the carrier's actual response is visible on-screen for a human to
        // confirm) but deliberately never calls ExchangeUssdBridge.arm() or
        // armPinInjection(). ExchangeUssdAccessibilityService.onAccessibilityEvent
        // and scanAndAct() both hard-return immediately whenever
        // ExchangeUssdBridge.armed is false, and armed is only ever set by
        // arm() — so with arm() never called, there is no PIN for the
        // service to inject and no code path here that could submit one,
        // regardless of whether the accessibility toggle happens to be on.
        // This is a structural guarantee, not a setting: it holds even if
        // the toggle's real-time state is wrong or stale. Revert to the
        // real executeLocked() (with arm()/awaitNextEvent()/
        // armPinInjection() restored) before this is ever used for a real
        // payout.
        dialer.dial(subscriptionId, body.step1UssdString)
        reportStep1(body.id, "ambiguous", "[diagnostic] Step 1 dialed; not proceeding to PIN entry.")
        return ExchangeDialResult(
            ExchangeDialOutcome.STEP1_FAILED,
            "[Diagnostic build] Step 1 dialed for real — check your phone screen for the carrier's actual response. This build stops here and will never submit a PIN.",
        )
    }

    private suspend fun reportStep1(attemptId: String, status: String, responseText: String?) {
        try {
            ApiClient.service.reportExchangeStep1(attemptId, ExchangeStepRequest(status, responseText))
        } catch (e: Exception) {
            DiagnosticsLog.record("exchange_dial_step1_report", "Failed to report step1 (attempt $attemptId): ${e.message}", isError = false)
        }
    }

    private suspend fun reportStep2(attemptId: String, status: String, responseText: String?, isFinalAttempt: Boolean) {
        try {
            ApiClient.service.reportExchangeStep2(attemptId, ExchangeStepRequest(status, responseText, isFinalAttempt))
        } catch (e: Exception) {
            DiagnosticsLog.record("exchange_dial_step2_report", "Failed to report step2 (attempt $attemptId): ${e.message}", isError = false)
        }
    }

    companion object {
        // Process-wide, mirroring UssdOrchestrator's own inFlight guard —
        // stops two concurrent taps (or a screen re-composition) from
        // dialing the same live-money payout twice.
        private val inFlightMutex = Mutex()
        private val inFlightOrderIds = mutableSetOf<String>()

        private suspend fun claim(orderId: String): Boolean = inFlightMutex.withLock {
            if (orderId in inFlightOrderIds) false else { inFlightOrderIds.add(orderId); true }
        }

        private suspend fun release(orderId: String) {
            inFlightMutex.withLock { inFlightOrderIds.remove(orderId) }
        }
    }
}
