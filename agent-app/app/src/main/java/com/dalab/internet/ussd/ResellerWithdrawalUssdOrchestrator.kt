package com.dalab.internet.ussd

import android.content.Context
import com.dalab.internet.data.ResellerWithdrawalPendingPayout
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.DialAttemptResultRequest
import com.dalab.internet.network.DialAttemptStartRequest
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.queue.RetryClassifier
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

/** Gson-serialized payload for a queued dial-attempt audit replay — mirrors
 * ussd/UssdOrchestrator.DialAttemptAuditAction's exact role, just against
 * the reseller-withdrawal-dial-attempts endpoints instead of orders'. */
data class ResellerWithdrawalDialAttemptAuditAction(
    val withdrawalId: String,
    val simSlot: Int,
    val ussdString: String,
    val attemptNumber: Int,
    val status: String,
    val responseMessage: String?,
)

/**
 * The fully-automatic Reseller Withdraw payout engine: dial the payout
 * company's combined number+amount+PIN USSD string with no agent/reseller
 * entering or triggering anything by hand. Reuses [UssdDialer] — the plain
 * TelephonyManager.sendUssdRequest() primitive Internet Store recharge
 * already automates — because reseller_withdrawals' payout_ussd_template is
 * the same one-shot combined string (see resellerDepositsWithdrawals.
 * routes.ts's WITHDRAWAL_SELECT doc comment), not Money Exchange's two-step
 * interactive PIN-prompt flow that needs ExchangeUssdOrchestrator's
 * AccessibilityService.
 *
 * Deliberately never marks the withdrawal 'completed' — a dial callback
 * firing only means the OS/carrier accepted the request, not that the
 * customer was actually paid. Only the real outgoing SMS (matched via the
 * backend's resellerSmsMatching.ts) or an admin's manual Complete ever does
 * that; this orchestrator's job ends at reporting the dial's own outcome for
 * audit/dedup, mirroring [UssdOrchestrator] and [ExchangeUssdOrchestrator]'s
 * exact shape.
 */
class ResellerWithdrawalUssdOrchestrator(context: Context, private val maxAttempts: Int = 3) {
    private val dialer = UssdDialer(context)

    suspend fun processPendingPayout(withdrawal: ResellerWithdrawalPendingPayout): DialResult {
        if (!claim(withdrawal.id)) {
            DiagnosticsLog.record(
                "reseller_withdrawal_duplicate_dial_guard",
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
        val ussdString = buildResellerWithdrawalUssdString(
            withdrawal.payoutUssdTemplate,
            withdrawal.destinationNumber,
            withdrawal.customerReceivesAmount,
        )

        // Reseller Withdraw's OWN routing table (reseller_withdrawal_sim_routing,
        // migration 058) — deliberately not SimRoutingRepository (Internet
        // Store/eBadal recharge's own routing), per product decision: a
        // company's withdrawal payout SIM can be a different device/slot
        // than that same company's recharge SIM.
        val route = when (val result = ResellerWithdrawalSimRoutingRepository.routeFor(withdrawal.companyId)) {
            is ResellerWithdrawalSimRouteResult.Route -> result.route
            ResellerWithdrawalSimRouteResult.NotConfigured -> return DialResult(DialOutcome.NO_SIM_CONFIGURED, "No withdrawal SIM routing configured for ${withdrawal.companyName}.")
            ResellerWithdrawalSimRouteResult.LoadFailed -> return DialResult(DialOutcome.NETWORK_UNAVAILABLE, "Could not load withdrawal SIM routing (network) — will retry.")
        }
        return dialWithRetry(withdrawal.id, route.simSlot, ussdString)
    }

    private suspend fun dialWithRetry(withdrawalId: String, simSlot: Int, ussdString: String): DialResult {
        var lastResult: DialResult = DialResult(DialOutcome.FAILED, "Not attempted")
        for (attempt in 1..maxAttempts) {
            val attemptId = startDialAttemptLog(withdrawalId, simSlot, ussdString, attempt)

            lastResult = when (val lookup = dialer.subscriptionIdForSlot(simSlot)) {
                SubscriptionLookupResult.PermissionMissing -> DialResult(
                    DialOutcome.PERMISSION_DENIED,
                    "Required phone permissions aren't granted on this device — check Settings > Apps > Dalab Agent > Permissions.",
                )
                SubscriptionLookupResult.NotPresent -> DialResult(DialOutcome.NO_SIM_PRESENT, "SIM $simSlot isn't physically inserted on this device.")
                is SubscriptionLookupResult.Found -> {
                    try {
                        // Reseller Withdraw's own stricter three-way classifier
                        // (SUCCESS/FAILED/AMBIGUOUS, never defaults unknown text
                        // to SUCCESS) — see classifyResellerWithdrawalUssdResponse
                        // in UssdDialer.kt for why this can't just reuse the
                        // Internet Store recharge default.
                        dialer.dial(lookup.subscriptionId, ussdString, classify = ::classifyResellerWithdrawalUssdResponse)
                    } catch (e: Exception) {
                        DiagnosticsLog.record("reseller_withdrawal_ussd_dial", "Dial threw (withdrawal $withdrawalId, attempt $attempt): ${e.message}", isError = true)
                        DialResult(DialOutcome.FAILED, "Dial error: ${e.message}")
                    }
                }
            }
            reportDialResult(withdrawalId, simSlot, ussdString, attempt, attemptId, lastResult)

            if (lastResult.outcome == DialOutcome.SUCCESS) return lastResult
            val retryable = lastResult.outcome == DialOutcome.FAILED ||
                lastResult.outcome == DialOutcome.TIMEOUT ||
                lastResult.outcome == DialOutcome.AMBIGUOUS
            if (!retryable) return lastResult // permission/config/no-SIM problems — don't retry blindly
            if (attempt < maxAttempts) delay(2000L * attempt) // simple linear backoff, same as UssdOrchestrator
        }
        return lastResult
    }

    private suspend fun startDialAttemptLog(withdrawalId: String, simSlot: Int, ussdString: String, attemptNumber: Int): String? {
        return try {
            val response = ApiClient.service.startResellerWithdrawalDialAttempt(
                withdrawalId,
                DialAttemptStartRequest(simSlot, ussdString, attemptNumber),
            )
            response.body()?.id
        } catch (e: Exception) {
            DiagnosticsLog.record("reseller_withdrawal_dial_attempt_log", "Start-log failed (withdrawal $withdrawalId, attempt $attemptNumber): ${e.message}", isError = false)
            null
        }
    }

    private suspend fun reportDialResult(
        withdrawalId: String, simSlot: Int, ussdString: String, attemptNumber: Int,
        attemptId: String?, result: DialResult,
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
                // fall through — queue a full replay below
            }
        }
        DiagnosticsLog.record("reseller_withdrawal_dial_attempt_log", "Queued full replay (withdrawal $withdrawalId, attempt $attemptNumber)", isError = false)
        PendingActionQueue.enqueue(
            id = UUID.randomUUID().toString(),
            type = PendingActionQueue.Type.RESELLER_WITHDRAWAL_DIAL_ATTEMPT_AUDIT,
            payload = ResellerWithdrawalDialAttemptAuditAction(withdrawalId, simSlot, ussdString, attemptNumber, status, result.responseMessage),
        )
    }

    companion object {
        // Process-wide, mirroring UssdOrchestrator/ExchangeUssdOrchestrator's
        // own in-flight guards — stops two overlapping sweeps (or a sweep
        // racing a future manual retry) from dialing the same live-money
        // payout twice.
        private val inFlightMutex = Mutex()
        private val inFlightWithdrawalIds = mutableSetOf<String>()

        private suspend fun claim(withdrawalId: String): Boolean = inFlightMutex.withLock {
            if (withdrawalId in inFlightWithdrawalIds) false else { inFlightWithdrawalIds.add(withdrawalId); true }
        }

        private suspend fun release(withdrawalId: String) {
            inFlightMutex.withLock { inFlightWithdrawalIds.remove(withdrawalId) }
        }

        /** Replays a queued [ResellerWithdrawalDialAttemptAuditAction] —
         * called by QueueDrainer. Lets any exception propagate so the caller
         * can classify it via RetryClassifier, same contract as
         * UssdOrchestrator.replayDialAttemptAudit. */
        suspend fun replayDialAttemptAudit(action: ResellerWithdrawalDialAttemptAuditAction) {
            val startResponse = RetryClassifier.requireSuccessful(
                ApiClient.service.startResellerWithdrawalDialAttempt(
                    action.withdrawalId,
                    DialAttemptStartRequest(action.simSlot, action.ussdString, action.attemptNumber),
                )
            )
            val attemptId = startResponse.body()?.id ?: error("startResellerWithdrawalDialAttempt returned no id")
            RetryClassifier.requireSuccessful(
                ApiClient.service.reportResellerWithdrawalDialResult(
                    attemptId,
                    DialAttemptResultRequest(action.status, action.responseMessage),
                )
            )
        }
    }
}

/**
 * Hormuud's *726* payout code does NOT accept a decimal amount as one
 * token. Confirmed live by manually dialing both forms on a real device:
 * "*726*617080008*1.05*8233#" (the previous behavior — a single "%.2f"
 * decimal token) got back "Haraaga xisaabtaadu kuguma filna, haraagaagu
 * waa: 5.367" — a generic-sounding insufficient-balance rejection that
 * restates the SIM's real balance and looks entirely plausible on its own,
 * but was actually a malformed-command rejection, not a real balance
 * problem: "*726*617080008*1*05*8233#" (dollars and cents as two separate
 * *-delimited tokens instead) succeeded for real — the carrier's own
 * outgoing confirmation SMS showed exactly $1.05 sent and the SIM balance
 * dropping by that amount. So {amount} in a payout template now expands to
 * "<dollars>*<cents>" (e.g. "1*05" for $1.05), not a plain decimal string —
 * the template's own surrounding literal "*"s (e.g.
 * "*726*{number}*{amount}*8233#") are what turn that into the carrier's
 * expected four-segment amount field once substituted.
 *
 * Only Hormuud has a payout_ussd_template configured today, so this is the
 * only real-world case this has been verified against — if a future
 * company's carrier genuinely wants plain decimal notation instead, that
 * would need its own per-company flag rather than assuming every provider
 * shares Hormuud's split-token requirement.
 */
internal fun formatHormuudSplitAmount(amount: Double): String {
    // Cents are computed by rounding amount*100 to the nearest whole cent
    // BEFORE splitting into dollars/cents, not by multiplying and
    // truncating the fractional part directly — a Double like 1.05 is not
    // stored exactly (it's ~1.0499999999999998 or ~1.0500000000000000444
    // depending on how it arrived), and splitting without rounding first
    // can silently produce the wrong cent (e.g. "1*04" instead of "1*05").
    val totalCents = Math.round(amount * 100)
    val dollars = totalCents / 100
    val cents = totalCents % 100
    return "$dollars*${cents.toString().padStart(2, '0')}"
}

/** Pulled out of [ResellerWithdrawalUssdOrchestrator.processLocked] as a
 * pure function (no Context/Android dependency) so the exact string dialed
 * to the carrier can be unit-tested directly — see
 * ResellerWithdrawalUssdOrchestratorTest. */
internal fun buildResellerWithdrawalUssdString(payoutUssdTemplate: String, destinationNumber: String, customerReceivesAmount: Double): String {
    return payoutUssdTemplate
        .replace("{number}", destinationNumber)
        .replace("{amount}", formatHormuudSplitAmount(customerReceivesAmount))
}
