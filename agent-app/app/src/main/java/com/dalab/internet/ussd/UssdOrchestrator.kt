package com.dalab.internet.ussd

import android.content.Context
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.DialAttemptResultRequest
import com.dalab.internet.network.DialAttemptStartRequest
import com.dalab.internet.network.VerifyPaymentRequest
import kotlinx.coroutines.delay

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
            return DialResult(DialOutcome.FAILED, "Could not reach server to verify payment: ${e.message}")
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
            reportDialResult(attemptId, lastResult)

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
            null // logging failure shouldn't block the actual dial attempt
        }
    }

    private suspend fun reportDialResult(attemptId: String?, result: DialResult) {
        if (attemptId == null) return
        val status = if (result.outcome == DialOutcome.SUCCESS) "success" else "failed"
        try {
            ApiClient.service.reportDialResult(attemptId, DialAttemptResultRequest(status, result.responseMessage))
        } catch (_: Exception) {
            // The order itself will still show as in_progress rather than
            // completed if this fails — visible to the Super Admin as
            // something needing manual attention, not silently lost.
        }
    }
}
