package com.dalab.internet.ussd

import android.content.Context
import android.os.PowerManager
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
        if (!ExchangeUssdBridge.isAccessibilityServiceEnabled(context)) {
            return ExchangeDialResult(
                ExchangeDialOutcome.ACCESSIBILITY_NOT_ENABLED,
                "Automated payout isn't enabled on this device yet — turn it on from More > Money Exchange Setup, or use manual payout below.",
            )
        }
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

        // Unlike Internet Store's PARTIAL_WAKE_LOCK (UssdDialer.kt) -- which
        // only keeps the CPU running for its screen-less sendUssdRequest()
        // call -- this flow needs the carrier's reply dialog to actually be
        // drawn on screen for ExchangeUssdAccessibilityService to read it.
        // With the screen off, ACTION_CALL still launches the system
        // dialer, but nothing gets rendered and no accessibility events
        // fire, so the whole attempt silently times out with no response at
        // all -- confirmed live (order DEX754272134: attempt reported
        // "failed" with a completely empty step1_response, the exact
        // signature of a plain 30s awaitNextEvent() timeout; confirmed
        // fixed live via a diagnostic build on order DEX591154444, which
        // captured the carrier's real response text with the screen off
        // beforehand). Deprecated in favor of per-Activity window flags
        // (FLAG_TURN_SCREEN_ON / setTurnScreenOn), but those only apply to
        // an Activity this app owns -- there's no way to set them on the
        // system dialer's own Activity that ACTION_CALL launches, so the
        // old WakeLock API is the only lever available here. Device has no
        // keyguard configured (confirmed) -- this wakes the screen to
        // whatever was already showing, it does not attempt to bypass any
        // lock.
        @Suppress("DEPRECATION")
        val wakeLock = (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)
            ?.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                "DalabAgent:ExchangeUssdDial",
            )
        wakeLock?.acquire(80_000)

        ExchangeUssdBridge.arm()
        try {
            dialer.dial(subscriptionId, body.step1UssdString)

            val firstEvent = awaitEventSkippingConfirmations(30_000)
            if (firstEvent !is UssdDialogEvent.DialogSeen) {
                reportStep1(body.id, "failed", null)
                return ExchangeDialResult(ExchangeDialOutcome.TIMEOUT, "No response from the carrier within 30s — check the phone and try manual payout if needed.")
            }
            if (!firstEvent.hasInput) {
                // Doesn't match the expected number+amount -> PIN-prompt shape
                // (e.g. an immediate error like "invalid number"). Never send
                // the PIN blind into an unexpected screen. (A legitimate
                // intermediate "confirm this transfer?" screen never reaches
                // here at all -- awaitEventSkippingConfirmations already
                // auto-tapped it and kept waiting.)
                reportStep1(body.id, "ambiguous", firstEvent.text)
                return ExchangeDialResult(ExchangeDialOutcome.STEP1_FAILED, "Unexpected carrier response (no PIN prompt): \"${firstEvent.text}\" — complete manually.")
            }
            reportStep1(body.id, "step1_success", firstEvent.text)

            ExchangeUssdBridge.armPinInjection(pin)
            val submittedEvent = awaitEventSkippingConfirmations(15_000)
            if (submittedEvent !is UssdDialogEvent.PinSubmitted) {
                reportStep2(body.id, "ambiguous", "PIN entry could not be confirmed automatically.", isFinalAttempt = true)
                return ExchangeDialResult(ExchangeDialOutcome.STEP2_FAILED, "Could not confirm the PIN was submitted — check the phone; the exchange may still be pending on the carrier's side.")
            }

            val finalEvent = awaitEventSkippingConfirmations(25_000)
            if (finalEvent !is UssdDialogEvent.DialogSeen) {
                reportStep2(body.id, "ambiguous", "No final confirmation received after entering the PIN.", isFinalAttempt = true)
                return ExchangeDialResult(ExchangeDialOutcome.TIMEOUT, "No final confirmation from the carrier — check the phone before retrying.")
            }
            val success = !looksLikeFailureResponse(finalEvent.text)
            reportStep2(body.id, if (success) "success" else "failed", finalEvent.text, isFinalAttempt = true)
            return if (success) {
                ExchangeDialResult(ExchangeDialOutcome.SUCCESS, finalEvent.text)
            } else {
                ExchangeDialResult(ExchangeDialOutcome.STEP2_FAILED, finalEvent.text)
            }
        } finally {
            ExchangeUssdBridge.disarm()
            if (wakeLock?.isHeld == true) wakeLock.release()
        }
    }

    /** Waits up to [timeoutMs] for a real event, transparently skipping any
     * number of [UssdDialogEvent.ConfirmationAdvanced] events along the
     * way (the accessibility service already auto-tapped those
     * intermediate "confirm this transfer?" screens) — so a multi-screen
     * carrier flow doesn't eat into the caller's actual response budget
     * beyond the wall-clock time it takes. Returns null once the full
     * budget is spent with no non-confirmation event, same as a plain
     * awaitNextEvent timeout.
     *
     * Always drains any already-buffered event first: the conflated
     * channel can pick up a stray DialogSeen for a still-on-screen dialog
     * re-firing an accessibility event during the *previous* step's own
     * network round-trip (e.g. reportStep1's suspend call) — without the
     * drain, this wait would instantly "receive" that stale leftover
     * instead of actually watching for what happens from this point on. */
    private suspend fun awaitEventSkippingConfirmations(timeoutMs: Long): UssdDialogEvent? {
        ExchangeUssdBridge.drainStaleEvents()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) return null
            val event = ExchangeUssdBridge.awaitNextEvent(remaining)
            if (event is UssdDialogEvent.ConfirmationAdvanced) {
                DiagnosticsLog.record(
                    "exchange_confirmation_advanced",
                    "Auto-tapped a ${event.stage} confirmation screen; continuing to wait (~${remaining}ms left in this step's budget).",
                    isError = false,
                )
                continue
            }
            return event
        }
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
