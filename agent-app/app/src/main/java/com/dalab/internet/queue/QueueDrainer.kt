package com.dalab.internet.queue

import android.content.Context
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.sms.SmsUploadAction
import com.dalab.internet.sms.SmsUploadFlow
import com.dalab.internet.sms.UploadOutcome
import com.dalab.internet.sms.VerifyPaymentAction
import com.dalab.internet.sms.ExchangePayoutConfirmationAction
import com.dalab.internet.sms.VoucherConfirmationAction
import com.dalab.internet.ussd.DialAttemptAuditAction
import com.dalab.internet.ussd.ExchangeDialStepReportAction
import com.dalab.internet.ussd.ExchangeUssdOrchestrator
import com.dalab.internet.ussd.UssdOrchestrator
import java.util.UUID

/**
 * Replays queued [PendingActionQueue] items against the backend — invoked
 * from AgentBackgroundService both on an immediate connectivity-restored
 * callback and on a periodic fallback tick, so a payment/audit record queued
 * while offline resolves automatically without the agent doing anything.
 *
 * Items are replayed strictly one at a time in this same for-loop (never in
 * parallel), and each SALE_CREATE only leaves the queue once its own request
 * has actually succeeded (or is confirmed a terminal rejection) — so a batch
 * of queued sales is sent, and confirmed, one order at a time, exactly as if
 * the agent were tapping "Create Sale" repeatedly by hand once back online.
 */
object QueueDrainer {

    suspend fun drainAll(context: Context) {
        val hadPendingSales = PendingActionQueue.all().any { it.type == PendingActionQueue.Type.SALE_CREATE }
        if (hadPendingSales) PendingSalesSyncStatus.markSyncing()

        // Snapshot at the start of this pass — anything enqueued mid-drain
        // (e.g. a fresh SMS arriving right now) is picked up on the next pass.
        for (action in PendingActionQueue.all()) {
            drainOne(context, action)
        }

        if (hadPendingSales) PendingSalesSyncStatus.markDrainResult()
    }

    private suspend fun drainOne(context: Context, action: PendingActionQueue.PendingAction) {
        try {
            when (action.type) {
                PendingActionQueue.Type.SMS_UPLOAD -> drainSmsUpload(context, action)
                PendingActionQueue.Type.VERIFY_PAYMENT -> drainVerifyPayment(context, action)
                PendingActionQueue.Type.DIAL_ATTEMPT_AUDIT -> {
                    UssdOrchestrator.replayDialAttemptAudit(PendingActionQueue.payloadOf(action))
                    PendingActionQueue.remove(action.id)
                }
                PendingActionQueue.Type.EXCHANGE_DIAL_STEP_REPORT -> {
                    ExchangeUssdOrchestrator.replayDialStepReport(PendingActionQueue.payloadOf<ExchangeDialStepReportAction>(action))
                    PendingActionQueue.remove(action.id)
                }
                PendingActionQueue.Type.VOUCHER_CONFIRMATION -> drainVoucherConfirmation(action)
                PendingActionQueue.Type.EXCHANGE_PAYOUT_CONFIRMATION -> drainExchangePayoutConfirmation(action)
                PendingActionQueue.Type.SALE_CREATE -> {
                    val payload = PendingActionQueue.payloadOf<SaleCreateAction>(action)
                    RetryClassifier.requireSuccessful(ApiClient.service.createSale(payload.request))
                    PendingActionQueue.remove(action.id)
                }
            }
        } catch (e: Exception) {
            // Only DIAL_ATTEMPT_AUDIT's, EXCHANGE_DIAL_STEP_REPORT's, and
            // SALE_CREATE's replay can throw here — SMS_UPLOAD and
            // VERIFY_PAYMENT classify their own outcome via the sealed
            // UploadOutcome instead of exceptions.
            if (RetryClassifier.isRetryable(e)) {
                PendingActionQueue.markAttempt(action.id, e.message)
            } else {
                DiagnosticsLog.record("queue_drain", "Dropped ${action.type} (terminal): ${e.message}")
                PendingActionQueue.remove(action.id) // terminal — will never succeed, drop it
            }
        }
    }

    private suspend fun drainSmsUpload(context: Context, action: PendingActionQueue.PendingAction) {
        val payload = PendingActionQueue.payloadOf<SmsUploadAction>(action)
        when (val outcome = SmsUploadFlow.uploadAndProcess(context, payload.entry)) {
            is UploadOutcome.Success -> PendingActionQueue.remove(action.id)
            is UploadOutcome.RetryableUpload -> PendingActionQueue.markAttempt(action.id, outcome.reason)
            is UploadOutcome.RetryableVerify -> {
                // The upload itself succeeded this time — swap this queued item
                // for a VERIFY_PAYMENT one instead of re-uploading the same SMS
                // again next pass (the SMS is already durably recorded server-side).
                PendingActionQueue.remove(action.id)
                PendingActionQueue.enqueue(
                    id = UUID.randomUUID().toString(),
                    type = PendingActionQueue.Type.VERIFY_PAYMENT,
                    payload = VerifyPaymentAction(outcome.orderId, outcome.smsLogId, payload.entry.parsedAmount),
                )
            }
            is UploadOutcome.Terminal -> {
                DiagnosticsLog.record("queue_drain", "Dropped SMS_UPLOAD (terminal): ${outcome.reason}")
                PendingActionQueue.remove(action.id) // rejected — will never succeed
            }
        }
    }

    private suspend fun drainVerifyPayment(context: Context, action: PendingActionQueue.PendingAction) {
        val payload = PendingActionQueue.payloadOf<VerifyPaymentAction>(action)
        when (val outcome = SmsUploadFlow.resumeVerifyPayment(context, payload.orderId, payload.smsLogId, payload.parsedAmount)) {
            is UploadOutcome.Success -> PendingActionQueue.remove(action.id)
            is UploadOutcome.RetryableVerify -> PendingActionQueue.markAttempt(action.id, outcome.reason)
            is UploadOutcome.Terminal, is UploadOutcome.RetryableUpload -> PendingActionQueue.remove(action.id) // unreachable from resumeVerifyPayment
        }
    }

    private suspend fun drainVoucherConfirmation(action: PendingActionQueue.PendingAction) {
        val payload = PendingActionQueue.payloadOf<VoucherConfirmationAction>(action)
        when (val outcome = SmsUploadFlow.reportVoucherConfirmation(payload.entry)) {
            is UploadOutcome.Success -> PendingActionQueue.remove(action.id)
            is UploadOutcome.RetryableUpload -> PendingActionQueue.markAttempt(action.id, outcome.reason)
            is UploadOutcome.Terminal -> {
                DiagnosticsLog.record("queue_drain", "Dropped VOUCHER_CONFIRMATION (terminal): ${outcome.reason}")
                PendingActionQueue.remove(action.id)
            }
            is UploadOutcome.RetryableVerify -> PendingActionQueue.remove(action.id) // unreachable from reportVoucherConfirmation
        }
    }

    private suspend fun drainExchangePayoutConfirmation(action: PendingActionQueue.PendingAction) {
        val payload = PendingActionQueue.payloadOf<ExchangePayoutConfirmationAction>(action)
        when (val outcome = SmsUploadFlow.reportExchangePayoutConfirmation(payload.entry)) {
            is UploadOutcome.Success -> PendingActionQueue.remove(action.id)
            is UploadOutcome.RetryableUpload -> PendingActionQueue.markAttempt(action.id, outcome.reason)
            is UploadOutcome.Terminal -> {
                DiagnosticsLog.record("queue_drain", "Dropped EXCHANGE_PAYOUT_CONFIRMATION (terminal): ${outcome.reason}")
                PendingActionQueue.remove(action.id)
            }
            is UploadOutcome.RetryableVerify -> PendingActionQueue.remove(action.id) // unreachable from reportExchangePayoutConfirmation
        }
    }
}
