package com.dalab.internet.sms

import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.dalab.internet.MainActivity
import com.dalab.internet.R
import com.dalab.internet.data.SmsLogEntry
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.ExchangePayoutConfirmationRequest
import com.dalab.internet.network.VoucherConfirmationRequest
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.queue.RetryClassifier
import com.dalab.internet.ussd.DialOutcome
import com.dalab.internet.ussd.UssdOrchestrator
import retrofit2.HttpException
import java.util.concurrent.ConcurrentHashMap

/** Gson-serialized payloads for the action types this flow can enqueue. */
data class SmsUploadAction(val entry: SmsLogEntry)
data class VerifyPaymentAction(val orderId: String, val smsLogId: String?, val parsedAmount: Double?)
data class VoucherConfirmationAction(val entry: VoucherSentEntry)
data class ExchangePayoutConfirmationAction(val entry: ExchangePayoutConfirmedEntry)

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

    /** Fingerprints of SMS being uploaded right now, so the live receiver,
     * an inbox recovery pass and the queue drainer never upload the same SMS
     * at the same moment. */
    private val inFlight: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private const val IN_FLIGHT = "already uploading"

    /** Queue id of an SMS's durable upload entry: one per SMS, whoever
     * found it first (receiver or recovery). */
    fun queueIdFor(fingerprint: String) = "sms_$fingerprint"

    /**
     * Durable intake for one SMS (live receiver and inbox recovery both use
     * this): saved to the upload queue BEFORE any network call, uploaded, and
     * only removed from the queue once the server has acknowledged it. A
     * failed upload stays queued and QueueDrainer retries it with backoff,
     * immediately when connectivity returns. An SMS the server already
     * acknowledged is not uploaded again.
     */
    suspend fun intake(context: Context, entry: SmsLogEntry, source: String): UploadOutcome {
        val fp = SmsRecoveryLogic.fingerprint(entry.sender, entry.body)
        val label = describe(entry, fp, source)
        if (SmsFingerprintStore.isAcked(fp)) {
            DiagnosticsLog.record("sms_duplicate_rejected", "Already acknowledged by the server — not uploaded again ($label).", isError = false)
            return UploadOutcome.Success
        }
        val queueId = queueIdFor(fp)
        PendingActionQueue.enqueueIfAbsent(queueId, PendingActionQueue.Type.SMS_UPLOAD, SmsUploadAction(entry))
        SmsFingerprintStore.markQueued(fp)
        DiagnosticsLog.record("sms_queued_for_upload", "Saved for upload ($label).", isError = false)
        val outcome = uploadGuarded(context, entry, fp)
        settle(queueId, fp, outcome, label)
        return outcome
    }

    /** One upload of a queued SMS, never two at once for the same SMS. */
    suspend fun uploadGuarded(context: Context, entry: SmsLogEntry, fingerprint: String): UploadOutcome {
        if (!inFlight.add(fingerprint)) return UploadOutcome.RetryableUpload(IN_FLIGHT)
        return try {
            uploadAndProcess(context, entry)
        } finally {
            inFlight.remove(fingerprint)
        }
    }

    /** Queue/ledger bookkeeping after an upload attempt of [queueId]. Any
     * answer from the server (stored, matched, duplicate, rejected) is an
     * acknowledgement; only "no answer" keeps it queued. */
    fun settle(queueId: String, fingerprint: String, outcome: UploadOutcome, label: String) {
        when (outcome) {
            is UploadOutcome.RetryableUpload -> {
                if (outcome.reason == IN_FLIGHT) return // the other upload settles it
                PendingActionQueue.markAttempt(queueId, outcome.reason)
                DiagnosticsLog.record("sms_upload_failed", "Upload failed, kept for automatic retry ($label): ${outcome.reason}")
            }
            is UploadOutcome.Terminal -> {
                PendingActionQueue.remove(queueId)
                SmsFingerprintStore.markAcked(fingerprint)
                DiagnosticsLog.record("sms_upload_failed", "Server rejected the upload, not retried ($label): ${outcome.reason}")
            }
            is UploadOutcome.RetryableVerify, UploadOutcome.Success -> {
                // RetryableVerify: the SMS itself is stored server-side; its
                // verify step is already durably queued as verify_<orderId>.
                PendingActionQueue.remove(queueId)
                SmsFingerprintStore.markAcked(fingerprint)
                DiagnosticsLog.record("sms_upload_succeeded", "Server acknowledged ($label).", isError = false)
            }
        }
    }

    private fun describe(entry: SmsLogEntry, fingerprint: String, source: String): String =
        "from ${entry.sender}, amount=${entry.parsedAmount ?: "?"}, sim=${entry.simSlot ?: "?"}, via $source, id=${fingerprint.take(10)}"

    suspend fun uploadAndProcess(context: Context, parsed: SmsLogEntry): UploadOutcome {
        val uploadResponse = try {
            RetryClassifier.requireSuccessful(ApiClient.service.uploadSmsLog(parsed))
        } catch (e: Exception) {
            // A 401 reaching here means ApiClient's own Authenticator already
            // tried a refresh-and-retry once (see refreshAuthenticator) and
            // that attempt also failed — but AgentBackgroundService's
            // session-expired listener kicks off an async silent device
            // re-login right after this exact failure (AgentEventBus.
            // emitSessionExpired), which frequently succeeds moments later.
            // A token that was stale at this instant says nothing about
            // whether this SMS is a genuinely bad request, unlike every
            // other 4xx RetryClassifier treats as terminal — so this is the
            // one exception carved out from "retrying unchanged would never
            // succeed": queue it (same SMS_UPLOAD retry path every other
            // retryable failure already uses) instead of permanently
            // dropping a real customer payment because the token happened
            // to expire at the wrong moment.
            val isRefreshableAuthFailure = e is HttpException && e.code() == 401
            val retryable = isRefreshableAuthFailure || RetryClassifier.isRetryable(e)
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

    /**
     * Money Exchange's own outgoing-confirmation half — reports a payout
     * confirmation (see [ExchangePayoutSentParsers]) so the backend can
     * complete the matching order as a corroborating signal alongside
     * ExchangeUssdOrchestrator's own step2 report. Mirrors
     * [reportVoucherConfirmation] exactly; best-effort/idempotent
     * server-side — a redundant or unmatched confirmation is not an error.
     */
    suspend fun reportExchangePayoutConfirmation(entry: ExchangePayoutConfirmedEntry): UploadOutcome {
        return try {
            RetryClassifier.requireSuccessful(
                ApiClient.service.reportExchangePayoutConfirmation(
                    ExchangePayoutConfirmationRequest(entry.receiverPhone, entry.amount, entry.rawText)
                )
            )
            UploadOutcome.Success
        } catch (e: Exception) {
            val retryable = RetryClassifier.isRetryable(e)
            DiagnosticsLog.record("exchange_payout_confirmation", "${if (retryable) "Queued for retry" else "Rejected"}: ${e.message}")
            if (retryable) UploadOutcome.RetryableUpload(e.message ?: "network error")
            else UploadOutcome.Terminal(e.message ?: "exchange payout confirmation failed")
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
            DialOutcome.AMBIGUOUS -> "Check order $orderId" to (detail ?: "The carrier's response didn't clearly confirm the top-up — verify manually.")
            DialOutcome.NO_SIM_CONFIGURED -> "Action needed: order $orderId" to "No SIM routing configured for this provider — set it up in SIM Routing."
            DialOutcome.NO_SIM_PRESENT -> "Action needed: order $orderId" to "Configured SIM isn't inserted in this device."
            DialOutcome.PERMISSION_DENIED -> "Action needed: order $orderId" to "Phone/SMS permission missing — dialing couldn't run."
            DialOutcome.TIMEOUT -> "Check order $orderId" to "USSD dial timed out after retries — verify manually."
            DialOutcome.NETWORK_UNAVAILABLE -> "Order $orderId — \$${amount ?: "?"}" to "Waiting for connectivity to verify payment — will retry automatically."
            DialOutcome.FAILED -> "Order $orderId — \$${amount ?: "?"}" to (detail ?: "USSD dial failed after retries.")
            DialOutcome.DUPLICATE_SKIPPED -> "Order $orderId — \$${amount ?: "?"}" to "Duplicate dial attempt skipped (already being processed)."
            // Already notified with the full details by SimBalanceAlerts
            // (UssdOrchestrator) -- don't post a second notification.
            DialOutcome.INSUFFICIENT_SIM_BALANCE, DialOutcome.SIM_BALANCE_UNVERIFIED -> return
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
