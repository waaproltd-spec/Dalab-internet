package com.dalab.internet.sms

import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.dalab.internet.MainActivity
import com.dalab.internet.R
import com.dalab.internet.data.SmsLogEntry
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.VoucherConfirmationRequest
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.queue.RetryClassifier
import com.dalab.internet.ussd.DialOutcome
import com.dalab.internet.ussd.UssdOrchestrator

/** Gson-serialized payloads for the action types this flow can enqueue. */
data class SmsUploadAction(val entry: SmsLogEntry)
data class VerifyPaymentAction(val orderId: String, val smsLogId: String?, val parsedAmount: Double?)
data class VoucherConfirmationAction(val entry: VoucherSentEntry)

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

        if (body?.duplicate == true) {
            DiagnosticsLog.record(
                "sms_duplicate_rejected",
                "Payment already processed (order=$matchedOrderId, orderAlreadyCompleted=${body.orderAlreadyCompleted}) — not re-matched or re-dialed.",
                isError = false,
            )
            // The order this payment already fulfilled is done — re-running
            // verify/dial here would be attempting to reuse the same real-world
            // payment for a second completion, exactly what this check exists
            // to prevent. If it's somehow still pending (this exact message
            // uploaded twice in quick succession before the first dial ran),
            // falling through to processMatched is safe — that path is itself
            // atomic/idempotent server-side.
            if (matchedOrderId == null || body.orderAlreadyCompleted) return UploadOutcome.Success
        }

        if (matchedOrderId != null && requiresManualApproval) {
            notifyManualApprovalNeeded(context, matchedOrderId, parsed.parsedAmount)
            return UploadOutcome.Success
        }
        if (matchedOrderId == null) return UploadOutcome.Success // unmatched SMS — nothing further to do

        return processMatched(context, matchedOrderId, smsLogId, parsed.parsedAmount)
    }

    /**
     * Flow 2's second half: reports an outgoing voucher-sent confirmation
     * (see [VoucherSentParsers]) so the backend can complete the matching
     * in_progress order as a corroborating signal alongside the USSD dial's
     * own response. Best-effort/idempotent server-side — a redundant or
     * unmatched confirmation is not an error, just a no-op.
     */
    suspend fun reportVoucherConfirmation(entry: VoucherSentEntry): UploadOutcome {
        return try {
            RetryClassifier.requireSuccessful(
                ApiClient.service.reportVoucherConfirmation(
                    VoucherConfirmationRequest(entry.receiverPhone, entry.amount, entry.provider)
                )
            )
            UploadOutcome.Success
        } catch (e: Exception) {
            val retryable = RetryClassifier.isRetryable(e)
            DiagnosticsLog.record("voucher_confirmation", "${if (retryable) "Queued for retry" else "Rejected"}: ${e.message}")
            if (retryable) UploadOutcome.RetryableUpload(e.message ?: "network error")
            else UploadOutcome.Terminal(e.message ?: "voucher confirmation failed")
        }
    }

    /** Resumes just the verify/dial/notify tail for a previously-uploaded SMS
     * whose verify-payment call failed on connectivity — called by QueueDrainer
     * for a queued VERIFY_PAYMENT action, skipping the (already-succeeded) upload. */
    suspend fun resumeVerifyPayment(context: Context, orderId: String, smsLogId: String?, parsedAmount: Double?): UploadOutcome =
        processMatched(context, orderId, smsLogId, parsedAmount)

    private suspend fun processMatched(context: Context, matchedOrderId: String, smsLogId: String?, parsedAmount: Double?): UploadOutcome {
        // Persisted BEFORE the risky verify->dial chain runs (not just after a
        // failure is classified) — a process death anywhere in that chain
        // (verify-payment succeeding but the app being killed before the dial
        // attempt is even logged) now leaves a durable trace that
        // AgentBackgroundService's existing queue-drain on next start will pick
        // up and resume, instead of the order silently sitting in_progress
        // forever with zero dial attempts and zero trace. Deterministic,
        // order-keyed id means a live call and a later drain-replay of this
        // same order can never create two queued entries for it.
        val actionId = "verify_$matchedOrderId"
        PendingActionQueue.enqueueIfAbsent(actionId, PendingActionQueue.Type.VERIFY_PAYMENT, VerifyPaymentAction(matchedOrderId, smsLogId, parsedAmount))

        val orchestrator = UssdOrchestrator(context)
        val result = orchestrator.processMatchedOrder(matchedOrderId, smsLogId)
        if (result.outcome == DialOutcome.NETWORK_UNAVAILABLE) {
            DiagnosticsLog.record("verify_payment", "Queued for retry (order $matchedOrderId): ${result.responseMessage}")
            // Entry from above stays in the queue — this IS the queued retry.
            return UploadOutcome.RetryableVerify(matchedOrderId, smsLogId, result.responseMessage ?: "verify-payment network error")
        }
        // Any other outcome is definitive (success or a terminal dial failure,
        // both already reported to the backend by UssdOrchestrator) — the
        // durable record of "this needs to run" is no longer needed.
        PendingActionQueue.remove(actionId)
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
            DialOutcome.DUPLICATE_SKIPPED -> "Order $orderId — \$${amount ?: "?"}" to "Duplicate dial attempt skipped (already being processed)."
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
