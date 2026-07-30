package com.dalab.internet.ussd

import android.content.Context
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.data.OrderStatus
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.DialAttemptResultRequest
import com.dalab.internet.network.DialAttemptStartRequest
import com.dalab.internet.network.VerifyPaymentRequest
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.queue.RetryClassifier
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

/** Gson-serialized payload for a queued dial-attempt audit replay — carries
 * everything needed to redo both the "start" and "result" logging calls
 * together (see [UssdOrchestrator.replayDialAttemptAudit]), since the two are
 * only ever meaningfully retried as a pair: the dial itself already happened
 * by the time either logging call can fail, so there's no separate "pending"
 * state worth persisting — only the already-known final outcome. */
data class DialAttemptAuditAction(
    val orderId: String,
    val simSlot: Int,
    val ussdString: String,
    val attemptNumber: Int,
    val status: String,
    val responseMessage: String?,
)

/**
 * The end-to-end automatic flow described in the spec:
 *   SMS matched -> verify payment -> pick correct SIM via routing config
 *   -> dial USSD -> wait for response -> mark order Success/Failed
 *   -> retry on failure, never silently drop.
 *
 * Called from SmsReceiver once /agent/sms-logs returns a matchedOrderId —
 * see SmsReceiver.kt's notifyAgent() path, which this replaces/extends with
 * the actual automatic dial rather than only a notification.
 */
class UssdOrchestrator(context: Context, private val maxAttempts: Int = 3) {
    private val dialer = UssdDialer(context)

    suspend fun processMatchedOrder(orderId: String, smsLogId: String?): DialResult {
        if (!claimOrder(orderId)) {
            DiagnosticsLog.record(
                "duplicate_dial_guard",
                "Order $orderId is already being processed by another in-flight call on this device (e.g. a concurrent self-heal sweep or manual retry) — skipping to prevent a duplicate recharge.",
                isError = false,
            )
            return DialResult(DialOutcome.DUPLICATE_SKIPPED, "Already being processed — skipped to avoid a duplicate recharge.")
        }
        try {
            return processMatchedOrderLocked(orderId, smsLogId)
        } finally {
            releaseOrder(orderId)
        }
    }

    private suspend fun processMatchedOrderLocked(orderId: String, smsLogId: String?): DialResult {
        // Step 1: verify payment (pending -> in_progress), which also triggers
        // the backend's own USSD string generation (see dalab-backend.zip,
        // routes/orders.js -> generateUssdForOrder).
        val verifyResponse = try {
            RetryClassifier.requireSuccessful(ApiClient.service.verifyPayment(orderId, VerifyPaymentRequest(smsLogId)))
        } catch (e: Exception) {
            // No connectivity right now, or the server responded with a
            // non-2xx status (as opposed to a genuinely rejected request) —
            // the caller (SmsUploadFlow) queues a retry instead of losing
            // this order to a transient network blip or backend hiccup.
            val outcome = if (RetryClassifier.isRetryable(e)) DialOutcome.NETWORK_UNAVAILABLE else DialOutcome.FAILED
            DiagnosticsLog.record("verify_payment", "Could not reach server (order $orderId): ${e.message}")
            return DialResult(outcome, "Could not reach server to verify payment: ${e.message}")
        }
        val order = verifyResponse.body() ?: return DialResult(DialOutcome.FAILED, "Verify-payment returned no order.")
        // verify-payment's CAS is idempotent on status (a second call for an
        // already-completed order is a no-op that just returns current
        // state) — but the returned order still carries its old
        // ussdGenerated string, so without this check the code below would
        // dial AGAIN for an order that already finished. This is the exact
        // mechanism that turned one real payment into 3 real USSD debits.
        if (order.status == OrderStatus.COMPLETED) {
            return DialResult(DialOutcome.SUCCESS, "Order already completed — skipping redundant dial.")
        }
        val ussdString = order.ussdGenerated
            ?: return DialResult(DialOutcome.FAILED, "No USSD template matched this order — check USSD Services in the dashboard.")

        // Step 2: resolve which physical SIM to dial on. A USSD template can
        // pin an order to a specific device+slot (Admin > USSD Templates),
        // which only means anything if *this* device is the one it named —
        // dialing still requires physically holding that SIM, so an override
        // naming a different device is ignored in favor of this device's own
        // per-company routing (logged for visibility, not treated as an error).
        val configuredSlot: Int = if (order.ussdDeviceId != null && order.ussdDeviceId == DeviceIdentity.deviceId() && order.ussdSimSlot != null) {
            order.ussdSimSlot
        } else {
            if (order.ussdDeviceId != null && order.ussdDeviceId != DeviceIdentity.deviceId()) {
                DiagnosticsLog.record(
                    "sim_routing",
                    "Order $orderId's template is assigned to a different device — falling back to this device's own routing for ${order.companyName}.",
                    isError = false,
                )
            }
            when (val result = SimRoutingRepository.simSlotFor(order.companyId)) {
                is SimSlotResult.Slot -> result.slot
                SimSlotResult.NotConfigured -> return DialResult(DialOutcome.NO_SIM_CONFIGURED, "No SIM routing configured for ${order.companyName}.")
                // A cold-start refresh failure, not a real "not configured" —
                // keep this in NETWORK_UNAVAILABLE so SmsUploadFlow preserves
                // the durable retry-queue entry instead of dropping it terminal.
                SimSlotResult.LoadFailed -> return DialResult(DialOutcome.NETWORK_UNAVAILABLE, "Could not load SIM routing (network) — will retry.")
            }
        }
        return dialWithRetry(orderId, configuredSlot, ussdString)
    }

    /**
     * Manual, agent-triggered execution from the Orders list — used when an
     * agent wants to force a specific SIM (e.g. the auto-matched SMS path
     * didn't fire, or the recommended slot is temporarily unusable) rather
     * than waiting for SmsReceiver to trigger [processMatchedOrder]. Still
     * goes through verify-payment first so the backend generates the USSD
     * string and the order state transitions the same way either path does;
     * the only difference is the caller supplies `forcedSimSlot` instead of
     * this resolving it from SimRoutingRepository/the template override.
     */
    suspend fun executeManually(orderId: String, forcedSimSlot: Int): DialResult {
        if (!claimOrder(orderId)) {
            DiagnosticsLog.record(
                "duplicate_dial_guard",
                "Order $orderId is already being processed by another in-flight call on this device (e.g. a concurrent self-heal sweep or the automatic SMS-triggered path) — skipping to prevent a duplicate recharge.",
                isError = false,
            )
            return DialResult(DialOutcome.DUPLICATE_SKIPPED, "Already being processed — skipped to avoid a duplicate recharge.")
        }
        try {
            return executeManuallyLocked(orderId, forcedSimSlot)
        } finally {
            releaseOrder(orderId)
        }
    }

    private suspend fun executeManuallyLocked(orderId: String, forcedSimSlot: Int): DialResult {
        val verifyResponse = try {
            RetryClassifier.requireSuccessful(ApiClient.service.verifyPayment(orderId, VerifyPaymentRequest(null)))
        } catch (e: Exception) {
            val outcome = if (RetryClassifier.isRetryable(e)) DialOutcome.NETWORK_UNAVAILABLE else DialOutcome.FAILED
            DiagnosticsLog.record("manual_execute", "Could not reach server (order $orderId): ${e.message}")
            return DialResult(outcome, "Could not reach server to verify payment: ${e.message}")
        }
        val order = verifyResponse.body() ?: return DialResult(DialOutcome.FAILED, "Verify-payment returned no order.")
        if (order.status == OrderStatus.COMPLETED) {
            return DialResult(DialOutcome.SUCCESS, "Order already completed — skipping redundant dial.")
        }
        val ussdString = order.ussdGenerated
            ?: return DialResult(DialOutcome.FAILED, "No USSD template matched this order — check USSD Services in the dashboard.")
        return dialWithRetry(orderId, forcedSimSlot, ussdString)
    }

    private suspend fun dialWithRetry(orderId: String, simSlot: Int, ussdString: String): DialResult {
        // Retry on transient failure/timeout (not on
        // NO_SIM_CONFIGURED/NO_SIM_PRESENT/PERMISSION_DENIED — those need a
        // human to fix, retrying won't help and would just waste USSD
        // sessions with the carrier).
        var lastResult: DialResult = DialResult(DialOutcome.FAILED, "Not attempted")
        for (attempt in 1..maxAttempts) {
            val attemptId = startDialAttemptLog(orderId, simSlot, ussdString, attempt)

            // subscriptionId is resolved inside the loop (not before it) so
            // a missing SIM still produces exactly one logged dial-attempt
            // row instead of returning before startDialAttemptLog ever runs
            // — previously this left zero trace anywhere (server or local)
            // that an attempt was even made.
            lastResult = when (val lookup = dialer.subscriptionIdForSlot(simSlot)) {
                // A lost CALL_PHONE/READ_PHONE_STATE permission looks identical
                // to a missing SIM at the API level — reported distinctly here so
                // it's never confused with an actually-empty SIM tray again.
                SubscriptionLookupResult.PermissionMissing -> DialResult(
                    DialOutcome.PERMISSION_DENIED,
                    "Required phone permissions aren't granted on this device — check Settings > Apps > Dalab Agent > Permissions.",
                )
                SubscriptionLookupResult.NotPresent -> DialResult(DialOutcome.NO_SIM_PRESENT, "SIM $simSlot isn't physically inserted on this device.")
                is SubscriptionLookupResult.Found -> {
                    // UssdDialer only catches SecurityException around the telephony
                    // call — other stack exceptions (e.g. IllegalStateException when
                    // the modem/RIL isn't ready) previously escaped uncaught all the
                    // way to QueueDrainer, which then classified them terminal and
                    // dropped a genuinely transient failure forever. Catching here
                    // converts it into a normal FAILED outcome, which this same retry
                    // loop already knows how to handle.
                    try {
                        dialer.dial(lookup.subscriptionId, ussdString)
                    } catch (e: Exception) {
                        DiagnosticsLog.record("ussd_dial", "Dial threw (order $orderId, attempt $attempt): ${e.message}", isError = true)
                        DialResult(DialOutcome.FAILED, "Dial error: ${e.message}")
                    }
                }
            }
            reportDialResult(orderId, simSlot, ussdString, attempt, attemptId, lastResult)

            if (lastResult.outcome == DialOutcome.SUCCESS) return lastResult
            if (lastResult.outcome != DialOutcome.FAILED && lastResult.outcome != DialOutcome.TIMEOUT) {
                return lastResult // permission/config/no-SIM problems — don't retry blindly
            }
            if (attempt < maxAttempts) {
                delay(2000L * attempt) // simple linear backoff between USSD retries
                // A concurrent path (a second SMS match, another device, or the
                // self-heal sweep) may have already completed this order while
                // this attempt was failing/timing out locally — re-check before
                // burning another real USSD session on the carrier. Fails open
                // (keeps retrying) on any network error here, so a flaky status
                // check can never itself cause a genuine payment to go undialed.
                val alreadyCompleted = try {
                    ApiClient.service.getOrder(orderId).body()?.status == OrderStatus.COMPLETED
                } catch (_: Exception) {
                    false
                }
                if (alreadyCompleted) {
                    return DialResult(DialOutcome.SUCCESS, "Order already completed — skipping remaining retries.")
                }
            }
        }
        return lastResult
    }

    private suspend fun startDialAttemptLog(orderId: String, simSlot: Int, ussdString: String, attemptNumber: Int): String? {
        return try {
            val response = ApiClient.service.startDialAttempt(orderId, DialAttemptStartRequest(simSlot, ussdString, attemptNumber))
            response.body()?.id
        } catch (e: Exception) {
            // Dial isn't blocked; reportDialResult below queues a full replay
            // covering both steps once the (already-known) outcome is in.
            DiagnosticsLog.record("dial_attempt_log", "Start-log failed (order $orderId, attempt $attemptNumber): ${e.message}", isError = false)
            null
        }
    }

    private suspend fun reportDialResult(
        orderId: String, simSlot: Int, ussdString: String, attemptNumber: Int,
        attemptId: String?, result: DialResult,
    ) {
        val status = if (result.outcome == DialOutcome.SUCCESS) "success" else "failed"
        if (attemptId != null) {
            try {
                ApiClient.service.reportDialResult(attemptId, DialAttemptResultRequest(status, result.responseMessage))
                return // both logging calls succeeded online — nothing to queue
            } catch (_: Exception) {
                // fall through — queue a full start+report replay below
            }
        }
        // Either the start call failed (attemptId null) or the result report
        // did — queue a full replay of both. Safe to redo "start" even if it
        // actually succeeded the first time: the backend's unique index on
        // (order_id, attempt_number) makes it an idempotent upsert.
        DiagnosticsLog.record("dial_attempt_log", "Queued full replay (order $orderId, attempt $attemptNumber)", isError = false)
        PendingActionQueue.enqueue(
            id = UUID.randomUUID().toString(),
            type = PendingActionQueue.Type.DIAL_ATTEMPT_AUDIT,
            payload = DialAttemptAuditAction(orderId, simSlot, ussdString, attemptNumber, status, result.responseMessage),
        )
    }

    companion object {
        // Process-wide (not per-instance): OrderDetailScreen, OrdersListScreen,
        // SmsUploadFlow, and SelfHealSweeper each construct their own
        // UssdOrchestrator instance, so an instance-level lock would do
        // nothing to stop two of them racing on the SAME orderId at the same
        // time -- confirmed root cause of a real incident where one payment
        // produced two real USSD dials/deductions (the direct SMS-triggered
        // path and a concurrent self-heal sweep both passed the existing
        // already-COMPLETED check, since neither dial had finished yet, and
        // both proceeded to physically dial). This is the single choke point
        // both processMatchedOrder and executeManually now go through.
        private val inFlightMutex = Mutex()
        private val inFlightOrderIds = mutableSetOf<String>()

        private suspend fun claimOrder(orderId: String): Boolean = inFlightMutex.withLock {
            if (orderId in inFlightOrderIds) false else { inFlightOrderIds.add(orderId); true }
        }

        private suspend fun releaseOrder(orderId: String) {
            inFlightMutex.withLock { inFlightOrderIds.remove(orderId) }
        }

        /** Replays a queued [DialAttemptAuditAction] — called by QueueDrainer.
         * Lets any exception propagate so the caller can classify it via
         * RetryClassifier (retryable -> keep queued, terminal -> drop). */
        suspend fun replayDialAttemptAudit(action: DialAttemptAuditAction) {
            val startResponse = RetryClassifier.requireSuccessful(
                ApiClient.service.startDialAttempt(
                    action.orderId,
                    DialAttemptStartRequest(action.simSlot, action.ussdString, action.attemptNumber),
                )
            )
            val attemptId = startResponse.body()?.id ?: error("startDialAttempt returned no id")
            RetryClassifier.requireSuccessful(
                ApiClient.service.reportDialResult(attemptId, DialAttemptResultRequest(action.status, action.responseMessage))
            )
        }
    }
}
