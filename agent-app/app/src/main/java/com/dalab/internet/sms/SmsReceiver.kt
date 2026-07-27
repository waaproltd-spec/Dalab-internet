package com.dalab.internet.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import com.dalab.internet.queue.PendingActionQueue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

/**
 * Fires on every incoming SMS (that's how Android SMS broadcasts work — the receiver
 * can't be scoped to "only payment SMS" at the OS level). [SmsListenerState.isListening]
 * gates whether we act on it; unmatched senders/formats are ignored by
 * [PaymentSmsParsers] regardless, so a personal text never gets uploaded.
 *
 * Full automatic flow (matches the spec): SMS -> parse -> upload -> matched
 * order -> UssdOrchestrator verifies payment, resolves the configured SIM,
 * dials the USSD, and reports the outcome — all without opening any screen.
 * A notification is still posted either way so the agent has visibility,
 * but it's informational, not something they need to act on for the happy path.
 *
 * The actual upload/match/verify/dial/notify logic lives in [SmsUploadFlow] so
 * a queued retry (see [PendingActionQueue], drained by AgentBackgroundService)
 * can resume the exact same flow after a connectivity gap instead of this
 * receiver's window silently dropping it.
 */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        if (!SmsListenerState.isListening.value) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        val sender = messages.firstOrNull()?.originatingAddress ?: return
        val body = messages.joinToString(separator = "") { it.messageBody ?: "" }
        val receivedAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).format(Date())

        val parsed = PaymentSmsParsers.parse(sender, body, receivedAt) ?: return
        SmsListenerState.recordLog(parsed)

        // BroadcastReceivers must finish quickly; goAsync() extends that window just
        // long enough for the network call + USSD dial below to complete or time out.
        // A USSD round-trip can take several seconds, which is why this whole
        // pipeline runs on a background coroutine rather than blocking onReceive.
        val pendingResult = goAsync()
        val appContext = context.applicationContext
        CoroutineScope(Dispatchers.IO).launch {
            try {
                when (val outcome = SmsUploadFlow.uploadAndProcess(appContext, parsed)) {
                    is UploadOutcome.RetryableUpload -> PendingActionQueue.enqueue(
                        id = UUID.randomUUID().toString(),
                        type = PendingActionQueue.Type.SMS_UPLOAD,
                        payload = SmsUploadAction(parsed),
                    )
                    is UploadOutcome.RetryableVerify -> PendingActionQueue.enqueue(
                        id = UUID.randomUUID().toString(),
                        type = PendingActionQueue.Type.VERIFY_PAYMENT,
                        payload = VerifyPaymentAction(outcome.orderId, outcome.smsLogId, parsed.parsedAmount),
                    )
                    is UploadOutcome.Terminal, UploadOutcome.Success -> {
                        // Terminal: the server rejected this SMS upload outright (a
                        // real 4xx) — resending it unchanged would never succeed, so
                        // it's not queued. Success: nothing further to do.
                    }
                }
            } finally {
                pendingResult.finish()
            }
        }
    }
}
