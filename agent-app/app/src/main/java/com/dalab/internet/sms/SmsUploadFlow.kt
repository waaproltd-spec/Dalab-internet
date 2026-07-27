package com.dalab.internet.sms

import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.dalab.internet.MainActivity
import com.dalab.internet.R
import com.dalab.internet.data.SmsLogEntry
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.queue.RetryClassifier
import com.dalab.internet.ussd.DialOutcome
import com.dalab.internet.ussd.UssdOrchestrator

/** Gson-serialized payloads for the two action types this flow can enqueue. */
data class SmsUploadAction(val entry: SmsLogEntry)
data class VerifyPaymentAction(val orderId: String, val smsLogId: String?, val parsedAmount: Double?)

sealed class UploadOutcome {
    object Success : UploadOutcome()
    /** No connectivity for the SMS upload call itself — caller enqueues a SMS_UPLOAD retry. */
    data class RetryableUpload(val reason: String) : UploadOutcome()
    /** SMS upload succeeded (matched an order) but the verify-payment call that follows
     * it failed only on connectivity — caller enqueues a VERIFY_PAYMENT retry instead of
     * re-uploading the (already-recorded) SMS. */
    data class RetryableVerify(val orderId: String, val smsLogId: String?, val reason: String) : UploadOutcome()
    /** The server actually rejected the request — retrying unchanged will never succeed. */
    data class Terminal(val reason: String) : UploadOutcome()
}

/**
 * The full automatic pipeline (upload -> match -> verify -> dial -> notify),
 * extracted out of SmsReceiver so a queue-drain retry (PendingActionQueue,
 * QueueDrainer) can resume exactly the same logic a fresh incoming SMS runs
 * inline, without duplicating it.
 */
object SmsUploadFlow {

    suspend fun uploadAndProcess(context: Context, parsed: SmsLogEntry): UploadOutcome {
        val uploadResponse = try {
            RetryClassifier.requireSuccessful(ApiClient.service.uploadSmsLog(parsed))
        } catch (e: Exception) {
            val retryable = RetryClassifier.isRetryable(e)
            DiagnosticsLog.record("sms_upload", "${if (retryable) "Queued for retry" else "Rejected"}: ${e.message}")
            return if (retryable) UploadOutcome.RetryableUpload(e.message ?: "network error")
            else UploadOutcome.Terminal(e.message ?: "upload failed")
        }

        val body = uploadResponse.body()
        val smsLogId = body?.id
        val matchedOrderId = body?.matchedOrderId
        val requiresManualApproval = body?.requiresManualApproval ?: false

        if (matchedOrderId != null && requiresManualApproval) {
            notifyManualApprovalNeeded(context, matchedOrderId, parsed.parsedAmount)
            return UploadOutcome.Success
        }
        if (matchedOrderId == null) return UploadOutcome.Success // unmatched SMS — nothing further to do

        return processMatched(context, matchedOrderId, smsLogId, parsed.parsedAmount)
    }

    /** Resumes just the verify/dial/notify tail for a previously-uploaded SMS
     * whose verify-payment call failed on connectivity — called by QueueDrainer
     * for a queued VERIFY_PAYMENT action, skipping the (already-succeeded) upload. */
    suspend fun resumeVerifyPayment(context: Context, orderId: String, smsLogId: String?, parsedAmount: Double?): UploadOutcome =
        processMatched(context, orderId, smsLogId, parsedAmount)

    private suspend fun processMatched(context: Context, matchedOrderId: String, smsLogId: String?, parsedAmount: Double?): UploadOutcome {
        val orchestrator = UssdOrchestrator(context)
        val result = orchestrator.processMatchedOrder(matchedOrderId, smsLogId)
        if (result.outcome == DialOutcome.NETWORK_UNAVAILABLE) {
            DiagnosticsLog.record("verify_payment", "Queued for retry (order $matchedOrderId): ${result.responseMessage}")
            return UploadOutcome.RetryableVerify(matchedOrderId, smsLogId, result.responseMessage ?: "verify-payment network error")
        }
        notifyAgent(context, matchedOrderId, parsedAmount, result.outcome, result.responseMessage)
        return UploadOutcome.Success
    }

    private fun notifyManualApprovalNeeded(context: Context, orderId: String, amount: Double?) {
        val openIntent = android.content.Intent(context, MainActivity::class.java).apply {
            putExtra("orderId", orderId)
        }
        val pendingIntent = android.app.PendingIntent.getActivity(
            context, 0, openIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, "payment_channel")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Payment received — order $orderId")
            .setContentText("\$${amount ?: "?"} matched. Automation is off for this provider — verify manually.")
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(orderId.hashCode(), notification)
    }

    private fun notifyAgent(context: Context, orderId: String, amount: Double?, outcome: DialOutcome, detail: String?) {
        val openIntent = android.content.Intent(context, MainActivity::class.java).apply {
            putExtra("orderId", orderId)
        }
        val pendingIntent = android.app.PendingIntent.getActivity(
            context, 0, openIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )
        val (title, text) = when (outcome) {
            DialOutcome.SUCCESS -> "Order $orderId completed" to "USSD confirmed automatically."
            DialOutcome.NO_SIM_CONFIGURED -> "Action needed: order $orderId" to "No SIM routing configured for this provider — set it up in SIM Routing."
            DialOutcome.NO_SIM_PRESENT -> "Action needed: order $orderId" to "Configured SIM isn't inserted in this device."
            DialOutcome.PERMISSION_DENIED -> "Action needed: order $orderId" to "Phone/SMS permission missing — dialing couldn't run."
            DialOutcome.TIMEOUT -> "Check order $orderId" to "USSD dial timed out after retries — verify manually."
            DialOutcome.NETWORK_UNAVAILABLE -> "Order $orderId — \$${amount ?: "?"}" to "Waiting for connectivity to verify payment — will retry automatically."
            DialOutcome.FAILED -> "Order $orderId — \$${amount ?: "?"}" to (detail ?: "USSD dial failed after retries.")
        }
        val notification = NotificationCompat.Builder(context, "payment_channel")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(orderId.hashCode(), notification)
    }
}
