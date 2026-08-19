package com.dalab.internet.ussd

import android.content.Context
import android.os.PowerManager
import com.dalab.internet.data.ResellerWithdrawalPendingPayout
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.DialAttemptResultRequest
import com.dalab.internet.network.DialAttemptStartRequest
import com.dalab.internet.queue.PendingActionQueue
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

/**
 * The automated Reseller Withdraw payout engine for a company whose carrier
 * menu is interactive/multi-step (eDahab's Reseller Service -> Transfer ->
 * number -> amount -> PIN) rather than [ResellerWithdrawalUssdOrchestrator]'s
 * one-shot combined dial string (Hormuud). Structurally this is
 * [ExchangeUssdOrchestrator] generalized from a fixed two-step (number+
 * amount, then PIN) flow to an arbitrary ordered sequence of replies — same
 * dial primitive ([ExchangeUssdDialer], reused directly since it's a
 * provider-agnostic ACTION_CALL wrapper), same "wait for a dialog, act on
 * it" event loop, same reporting endpoints Reseller Withdraw's own one-shot
 * orchestrator already uses (POST .../dial-attempts,
 * PUT .../dial-attempts/:attemptId) — reporting a final outcome doesn't care
 * how the dial was actually driven.
 *
 * Never marks the withdrawal 'completed' itself — exactly like both
 * [ResellerWithdrawalUssdOrchestrator] and [ExchangeUssdOrchestrator]: this
 * orchestrator's job ends at reporting the dial's own final classified
 * outcome; the backend's completeResellerWithdrawalFromDialResult (see
 * resellerDepositsWithdrawals.routes.ts) is what atomically claims the
 * withdrawal and debits the wallet, and only on a 'success' report.
 */
class ResellerWithdrawalInteractiveUssdOrchestrator(private val context: Context) {
    private val dialer = ExchangeUssdDialer(context)

    suspend fun processPendingPayout(withdrawal: ResellerWithdrawalPendingPayout): DialResult {
        if (!claim(withdrawal.id)) {
            DiagnosticsLog.record(
                "reseller_withdrawal_interactive_duplicate_dial_guard",
                "Withdrawal ${withdrawal.id} is already being processed by another in-flight call on this device — skipping to prevent a duplicate payout.",
                isError = false,
            )
            return DialResult(DialOutcome.DUPLICATE_SKIPPED, "Already being processed — skipped to avoid a duplicate payout.")
        }
        try {
            return processLocked(withdrawal)
        } finally {
            release(withdrawal.id)
        }
    }

    private suspend fun processLocked(withdrawal: ResellerWithdrawalPendingPayout): DialResult {
        val payout = withdrawal.interactivePayout
            ?: return DialResult(DialOutcome.FAILED, "No interactive payout config on this withdrawal — nothing to dial.")

        if (!ResellerWithdrawalInteractiveUssdBridge.isAccessibilityServiceEnabled(context)) {
            return DialResult(
                DialOutcome.PERMISSION_DENIED,
                "Automated payout isn't enabled on this device yet — turn it on from Settings > Accessibility, or complete this payout manually.",
            )
        }
        if (!dialer.hasRequiredPermissions()) {
            return DialResult(DialOutcome.PERMISSION_DENIED, "Phone permissions aren't granted — check Settings > Apps > Dalab Agent > Permissions.")
        }

        val route = when (val result = ResellerWithdrawalSimRoutingRepository.routeFor(withdrawal.companyId)) {
            is ResellerWithdrawalSimRouteResult.Route -> result.route
            ResellerWithdrawalSimRouteResult.NotConfigured -> return DialResult(DialOutcome.NO_SIM_CONFIGURED, "No withdrawal SIM routing configured for ${withdrawal.companyName}.")
            ResellerWithdrawalSimRouteResult.LoadFailed -> return DialResult(DialOutcome.NETWORK_UNAVAILABLE, "Could not load withdrawal SIM routing (network) — will retry.")
        }
        val subscriptionId = when (val lookup = dialer.subscriptionIdForSlot(route.simSlot)) {
            SubscriptionLookupResult.PermissionMissing -> return DialResult(DialOutcome.PERMISSION_DENIED, "Required phone permissions aren't granted on this device.")
            SubscriptionLookupResult.NotPresent -> return DialResult(DialOutcome.NO_SIM_PRESENT, "SIM ${route.simSlot} isn't physically inserted on this device.")
            is SubscriptionLookupResult.Found -> lookup.subscriptionId
        }

        val replies = buildResellerWithdrawalInteractiveReplies(
            payout.replySteps,
            withdrawal.destinationNumber,
            withdrawal.customerReceivesAmount,
            payout.pin,
        )
        val auditString = auditUssdString(payout)
        val attemptId = startDialAttemptLog(withdrawal.id, route.simSlot, auditString)

        // Same reasoning as ExchangeUssdOrchestrator: the carrier's reply
        // dialog must actually be drawn on screen for the accessibility
        // service to read it, so a plain background-safe dial is not
        // enough here (unlike Hormuud's one-shot sendUssdRequest()).
        @Suppress("DEPRECATION")
        val wakeLock = (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)
            ?.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                "DalabAgent:ResellerWithdrawalInteractiveUssdDial",
            )
        wakeLock?.acquire(120_000)
        ResellerWithdrawalInteractiveUssdBridge.activeWakeLock = wakeLock

        ResellerWithdrawalInteractiveUssdBridge.arm(replies.size)
        try {
            dialer.dial(subscriptionId, payout.initialDial)

            for ((index, reply) in replies.withIndex()) {
                val dialogEvent = awaitEventSkippingConfirmations(if (index == 0) 30_000L else 15_000L)
                if (dialogEvent !is UssdDialogEvent.DialogSeen) {
                    val result = DialResult(DialOutcome.TIMEOUT, "No response from the carrier at step ${index + 1} of ${replies.size} — check the phone or complete manually.")
                    reportDialResult(withdrawal.id, route.simSlot, auditString, attemptId, result)
                    return result
                }
                if (!dialogEvent.hasInput) {
                    // Doesn't match the expected "here's a field to fill in"
                    // shape (e.g. an immediate error like "invalid number").
                    // Never send the next reply blind into an unexpected
                    // screen.
                    val result = DialResult(DialOutcome.AMBIGUOUS, "Unexpected carrier response at step ${index + 1} of ${replies.size} (no input field): \"${dialogEvent.text}\" — complete manually.")
                    reportDialResult(withdrawal.id, route.simSlot, auditString, attemptId, result)
                    return result
                }

                ResellerWithdrawalInteractiveUssdBridge.armReplyInjection(reply)
                val submittedEvent = awaitEventSkippingConfirmations(15_000L)
                if (submittedEvent !is UssdDialogEvent.PinSubmitted) {
                    val result = DialResult(DialOutcome.AMBIGUOUS, "Could not confirm step ${index + 1} of ${replies.size} was submitted — check the phone; the withdrawal may still be pending on the carrier's side.")
                    reportDialResult(withdrawal.id, route.simSlot, auditString, attemptId, result)
                    return result
                }
            }

            val finalEvent = awaitEventSkippingConfirmations(25_000L)
            if (finalEvent !is UssdDialogEvent.DialogSeen) {
                val result = DialResult(DialOutcome.AMBIGUOUS, "No final confirmation from the carrier after the last reply — check the phone before retrying.")
                reportDialResult(withdrawal.id, route.simSlot, auditString, attemptId, result)
                return result
            }
            // Reseller Withdraw's own stricter three-way classifier — never
            // defaults unrecognized text to SUCCESS, same as the one-shot
            // orchestrator's UssdDialer.dial(classify = ...) path.
            val outcome = classifyResellerWithdrawalUssdResponse(finalEvent.text)
            val result = DialResult(outcome, finalEvent.text)
            reportDialResult(withdrawal.id, route.simSlot, auditString, attemptId, result)
            return result
        } finally {
            ResellerWithdrawalInteractiveUssdBridge.disarm()
            if (wakeLock?.isHeld == true) wakeLock.release()
            ResellerWithdrawalInteractiveUssdBridge.activeWakeLock = null
        }
    }

    /** Mirrors ExchangeUssdOrchestrator.awaitEventSkippingConfirmations
     * exactly — see its own doc comment for why confirmation-advanced
     * events must be transparently skipped and stale buffered events
     * drained before each wait. */
    private suspend fun awaitEventSkippingConfirmations(timeoutMs: Long): UssdDialogEvent? {
        ResellerWithdrawalInteractiveUssdBridge.drainStaleEvents()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) return null
            val event = ResellerWithdrawalInteractiveUssdBridge.awaitNextEvent(remaining)
            if (event is UssdDialogEvent.ConfirmationAdvanced) {
                DiagnosticsLog.record(
                    "reseller_withdrawal_interactive_confirmation_advanced",
                    "Auto-tapped a confirmation screen; continuing to wait (~${remaining}ms left in this step's budget).",
                    isError = false,
                )
                continue
            }
            return event
        }
    }

    private suspend fun startDialAttemptLog(withdrawalId: String, simSlot: Int, ussdString: String): String? {
        return try {
            val response = ApiClient.service.startResellerWithdrawalDialAttempt(
                withdrawalId,
                DialAttemptStartRequest(simSlot, ussdString, attemptNumber = 1),
            )
            response.body()?.id
        } catch (e: Exception) {
            DiagnosticsLog.record("reseller_withdrawal_interactive_dial_attempt_log", "Start-log failed (withdrawal $withdrawalId): ${e.message}", isError = false)
            null
        }
    }

    private suspend fun reportDialResult(
        withdrawalId: String, simSlot: Int, ussdString: String, attemptId: String?, result: DialResult,
    ) {
        val status = when (result.outcome) {
            DialOutcome.SUCCESS -> "success"
            DialOutcome.AMBIGUOUS -> "ambiguous"
            else -> "failed"
        }
        if (attemptId != null) {
            try {
                ApiClient.service.reportResellerWithdrawalDialResult(attemptId, DialAttemptResultRequest(status, result.responseMessage))
                return
            } catch (_: Exception) {
                // fall through — queue a full replay below, same recovery
                // path the one-shot orchestrator's reportDialResult uses.
            }
        }
        DiagnosticsLog.record("reseller_withdrawal_interactive_dial_attempt_log", "Queued full replay (withdrawal $withdrawalId, attemptId=$attemptId)", isError = false)
        // Reuses ResellerWithdrawalUssdOrchestrator's own audit-action type
        // and QueueDrainer replay handler — replayDialAttemptAudit always
        // redoes BOTH the start call and the report call (it has no way to
        // resume from an existing attemptId), so this must carry the real
        // withdrawalId/simSlot/ussdString every time, not just when attemptId
        // was null. The dedup key on the backend is (withdrawal_id,
        // attempt_number=1), so redoing the start call is a safe no-op if it
        // actually already succeeded — same idempotency the one-shot
        // orchestrator's own replay path relies on.
        PendingActionQueue.enqueue(
            id = UUID.randomUUID().toString(),
            type = PendingActionQueue.Type.RESELLER_WITHDRAWAL_DIAL_ATTEMPT_AUDIT,
            payload = ResellerWithdrawalDialAttemptAuditAction(
                withdrawalId = withdrawalId,
                simSlot = simSlot,
                ussdString = ussdString,
                attemptNumber = 1,
                status = status,
                responseMessage = result.responseMessage,
            ),
        )
    }

    companion object {
        private val inFlightMutex = Mutex()
        private val inFlightWithdrawalIds = mutableSetOf<String>()

        private suspend fun claim(withdrawalId: String): Boolean = inFlightMutex.withLock {
            if (withdrawalId in inFlightWithdrawalIds) false else { inFlightWithdrawalIds.add(withdrawalId); true }
        }

        private suspend fun release(withdrawalId: String) {
            inFlightMutex.withLock { inFlightWithdrawalIds.remove(withdrawalId) }
        }
    }
}

/** A human-readable, PIN-free description of the dial sequence for the
 * attempt's audit log (ussdString column) — the real replies (and
 * especially the PIN) are never sent to the backend at all, only this
 * summary and the eventual success/failed/ambiguous classification. */
internal fun auditUssdString(payout: com.dalab.internet.data.ResellerWithdrawalInteractivePayout): String {
    val maskedSteps = payout.replySteps.joinToString(" -> ") + " -> [PIN]"
    return "${payout.initialDial} -> $maskedSteps"
}

/** Pulled out as a pure function (no Context/Android dependency) so the
 * exact reply sequence dialed to the carrier can be unit-tested directly —
 * see ResellerWithdrawalInteractiveUssdOrchestratorTest. Substitutes
 * {number}/{amount} into each configured reply step (same placeholders
 * ResellerWithdrawalUssdOrchestrator's one-shot template already
 * substitutes) and always appends the PIN as the final reply — the carrier
 * only ever prompts for it after every other reply has been accepted, per
 * the real eDahab flow (Reseller Service -> Transfer -> number -> amount ->
 * PIN). Amount is formatted the same way [formatHormuudSplitAmount] rounds
 * to the nearest cent, but WITHOUT that function's Hormuud-specific
 * dollars*cents split token — eDahab's own flow takes the amount as a plain
 * decimal string in its own separate reply step, not one combined
 * multi-segment USSD field. */
internal fun buildResellerWithdrawalInteractiveReplies(
    replySteps: List<String>,
    destinationNumber: String,
    customerReceivesAmount: Double,
    pin: String,
): List<String> {
    val formattedAmount = formatPlainAmount(customerReceivesAmount)
    val substituted = replySteps.map { step ->
        step.replace("{number}", destinationNumber).replace("{amount}", formattedAmount)
    }
    return substituted + pin
}

/** Rounds to the nearest cent the same way formatHormuudSplitAmount does
 * (a Double like 1.05 is not stored exactly), but renders as a plain
 * decimal string ("1.05") rather than a dollars*cents split token — see
 * [buildResellerWithdrawalInteractiveReplies]'s doc comment for why this
 * needs its own formatting, distinct from Hormuud's one-shot template. */
internal fun formatPlainAmount(amount: Double): String {
    val totalCents = Math.round(amount * 100)
    val dollars = totalCents / 100
    val cents = totalCents % 100
    return "$dollars.${cents.toString().padStart(2, '0')}"
}
