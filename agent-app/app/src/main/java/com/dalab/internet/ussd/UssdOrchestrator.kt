package com.dalab.internet.ussd

import android.content.Context
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.DialAttemptResultRequest
import com.dalab.internet.network.DialAttemptStartRequest
import com.dalab.internet.network.VerifyPaymentRequest
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.queue.RetryClassifier
import kotlinx.coroutines.delay
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
        // Step 1: verify payment (pending -> in_progress), which also triggers
        // the backend's own USSD string generation (see dalab-backend.zip,
        // routes/orders.js -> generateUssdForOrder).
        val verifyResponse = try {
            ApiClient.service.verifyPayment(orderId, VerifyPaymentRequest(smsLogId))
        } catch (e: Exception) {
            // No connectivity right now (as opposed to the server actually
            // rejecting the request) — the caller (SmsUploadFlow) queues a
            // retry instead of losing this order to a transient network blip.
            val outcome = if (RetryClassifier.isRetryable(e)) DialOutcome.NETWORK_UNAVAILABLE else DialOutcome.FAILED
            return DialResult(outcome, "Could not reach server to verify payment: ${e.message}")
        }
        val order = verifyResponse.body() ?: return DialResult(DialOutcome.FAILED, "Verify-payment returned no order.")
        val ussdString = order.ussdGenerated
            ?: return DialResult(DialOutcome.FAILED, "No USSD template matched this order — check USSD Services in the dashboard.")

        // Step 2: resolve which physical SIM to dial on.
        val configuredSlot = SimRoutingRepository.simSlotFor(order.companyId)
            ?: return DialResult(DialOutcome.NO_SIM_CONFIGURED, "No SIM routing configured for ${order.companyName}.")
        val subscriptionId = dialer.subscriptionIdForSlot(configuredSlot)
            ?: return DialResult(DialOutcome.NO_SIM_PRESENT, "SIM $configuredSlot is configured for ${order.companyName} but isn't physically inserted.")

        // Step 3: dial, with retry on transient failure/timeout (not on
        // NO_SIM_CONFIGURED/NO_SIM_PRESENT/PERMISSION_DENIED — those need a
        // human to fix, retrying won't help and would just waste USSD
        // sessions with the carrier).
        var lastResult: DialResult = DialResult(DialOutcome.FAILED, "Not attempted")
        for (attempt in 1..maxAttempts) {
            val attemptId = startDialAttemptLog(orderId, configuredSlot, ussdString, attempt)

            lastResult = dialer.dial(subscriptionId, ussdString)
            reportDialResult(orderId, configuredSlot, ussdString, attempt, attemptId, lastResult)

            if (lastResult.outcome == DialOutcome.SUCCESS) return lastResult
            if (lastResult.outcome != DialOutcome.FAILED && lastResult.outcome != DialOutcome.TIMEOUT) {
                return lastResult // permission/config problems — don't retry blindly
            }
            if (attempt < maxAttempts) delay(2000L * attempt) // simple linear backoff between USSD retries
        }
        return lastResult
    }

    private suspend fun startDialAttemptLog(orderId: String, simSlot: Int, ussdString: String, attemptNumber: Int): String? {
        return try {
            val response = ApiClient.service.startDialAttempt(orderId, DialAttemptStartRequest(simSlot, ussdString, attemptNumber))
            response.body()?.id
        } catch (_: Exception) {
            null // dial isn't blocked; reportDialResult below queues a full replay covering both steps
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
        PendingActionQueue.enqueue(
            id = UUID.randomUUID().toString(),
            type = PendingActionQueue.Type.DIAL_ATTEMPT_AUDIT,
            payload = DialAttemptAuditAction(orderId, simSlot, ussdString, attemptNumber, status, result.responseMessage),
        )
    }

    companion object {
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
