package com.dalab.internet.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import com.dalab.internet.diagnostics.DiagnosticsLog
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
        if (!SmsListenerState.isListening.value) {
            // Previously a silent return — if listening gets disabled (or
            // never actually re-enabled after an app/process restart), every
            // subsequent payment SMS vanished with zero trace anywhere, making
            // "it worked once then stopped" impossible to tell apart from "the
            // OS never even ran the receiver again". Logging every ignored SMS
            // here means Diagnostics can now distinguish the two.
            DiagnosticsLog.record(
                "sms_receiver_ignored",
                "SMS ignored — listening is disabled (More > Permissions to re-check/re-enable).",
                isError = false,
            )
            return
        }

        // Everything from here runs on the main thread, on every single incoming
        // SMS (spam, OTPs, personal texts — not just payment messages), with no
        // user interaction at all — exactly the shape of a crash reported as
        // "the app closed on its own while just sitting there". Any exception
        // here previously had nothing catching it.
        val (sender, body, receivedAt) = try {
            val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
            val s = messages.firstOrNull()?.originatingAddress ?: return
            val b = messages.joinToString(separator = "") { it.messageBody ?: "" }
            val r = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).format(Date())
            Triple(s, b, r)
        } catch (e: Exception) {
            DiagnosticsLog.record("sms_receiver_extract", "Failed to read incoming SMS: ${e.stackTraceToString().take(2000)}")
            return
        }

        val (parsed, voucherSent) = try {
            val p = PaymentSmsParsers.parse(sender, body, receivedAt)
            val v = if (p == null) VoucherSentParsers.parse(sender, body) else null
            p to v
        } catch (e: Exception) {
            DiagnosticsLog.record("sms_receiver_parse", "Parser threw on incoming SMS: ${e.stackTraceToString().take(2000)}")
            return
        }
        if (parsed == null && voucherSent == null) {
            // Most SMS on this phone are personal texts/OTPs and are correctly
            // ignored here — logging every one of those would flood
            // Diagnostics and leak their content. But an SMS that *looks*
            // like a payment confirmation (mentions money/a provider keyword)
            // yet matched no parser is exactly the failure mode "some payment
            // SMS aren't picked up" describes — e.g. a provider slightly
            // changed their message wording. Previously this was
            // indistinguishable from "no SMS arrived at all".
            if (looksLikePaymentSms(body)) {
                DiagnosticsLog.record(
                    "sms_receiver_unrecognized",
                    "Payment-looking SMS from '$sender' matched no parser: ${body.take(160)}",
                )
            }
            return
        }

        // BroadcastReceivers must finish quickly; goAsync() extends that window just
        // long enough for the network call + USSD dial below to complete or time out.
        // A USSD round-trip can take several seconds, which is why this whole
        // pipeline runs on a background coroutine rather than blocking onReceive.
        val pendingResult = goAsync()
        val appContext = context.applicationContext
        CoroutineScope(Dispatchers.IO).launch {
            try {
                if (voucherSent != null) {
                    // Flow 2: agent's own SIM confirmed it sent the top-up — a
                    // corroborating signal, not an incoming customer payment.
                    if (SmsUploadFlow.reportVoucherConfirmation(voucherSent) is UploadOutcome.RetryableUpload) {
                        PendingActionQueue.enqueue(
                            id = UUID.randomUUID().toString(),
                            type = PendingActionQueue.Type.VOUCHER_CONFIRMATION,
                            payload = VoucherConfirmationAction(voucherSent),
                        )
                    }
                    return@launch
                }
                val entry = parsed!!
                SmsListenerState.recordLog(entry)
                when (val outcome = SmsUploadFlow.uploadAndProcess(appContext, entry)) {
                    is UploadOutcome.RetryableUpload -> PendingActionQueue.enqueue(
                        id = UUID.randomUUID().toString(),
                        type = PendingActionQueue.Type.SMS_UPLOAD,
                        payload = SmsUploadAction(entry),
                    )
                    is UploadOutcome.RetryableVerify -> PendingActionQueue.enqueue(
                        id = UUID.randomUUID().toString(),
                        type = PendingActionQueue.Type.VERIFY_PAYMENT,
                        payload = VerifyPaymentAction(outcome.orderId, outcome.smsLogId, entry.parsedAmount),
                    )
                    is UploadOutcome.Terminal, UploadOutcome.Success -> {
                        // Terminal: the server rejected this SMS upload outright (a
                        // real 4xx) — resending it unchanged would never succeed, so
                        // it's not queued. Success: nothing further to do.
                    }
                }
            } catch (e: Exception) {
                // Previously only a `finally` here — any exception from the upload/
                // match/dial pipeline propagated straight up and crashed the app
                // with zero record of what happened.
                DiagnosticsLog.record("sms_receiver_process", "Failed processing incoming SMS: ${e.stackTraceToString().take(2000)}")
            } finally {
                pendingResult.finish()
            }
        }
    }
}

/** Cheap heuristic, not a parser — used only to decide whether an
 * unrecognized SMS is worth a diagnostics entry (see the unparsed-SMS branch
 * above) without logging every ordinary personal text/OTP that passes
 * through this receiver. */
private val PAYMENT_LOOKING_KEYWORDS = listOf(
    "heshay", "ka heshay", "dollar", "aqanoosiga", "edahab", "e-dahab",
    "evcplus", "evc plus", "somnet", "haraagagu", "haraagaaga",
)

private fun looksLikePaymentSms(body: String): Boolean {
    val lower = body.lowercase()
    return lower.contains("$") || PAYMENT_LOOKING_KEYWORDS.any { lower.contains(it) }
}
