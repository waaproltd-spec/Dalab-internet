package com.dalab.internet.sms

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Telephony
import android.telephony.SubscriptionManager
import androidx.core.content.ContextCompat
import com.dalab.internet.data.SmsLogEntry
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

        // Pulled out of the parse try/catch below — resolveSimSlot never throws
        // (it has its own internal try/catch) — so it can be reused both for
        // PaymentSmsParsers.parse's simSlot argument and, further down, for the
        // Reseller Withdraw upload built from an exchangePayoutSent match.
        val resolvedSimSlot = resolveSimSlot(context, intent)
        val (parsed, voucherSent, exchangePayoutSent) = try {
            val p = PaymentSmsParsers.parse(sender, body, receivedAt, resolvedSimSlot)
            val v = if (p == null) VoucherSentParsers.parse(sender, body) else null
            val e = if (p == null && v == null) ExchangePayoutSentParsers.parse(sender, body) else null
            Triple(p, v, e)
        } catch (e: Exception) {
            DiagnosticsLog.record("sms_receiver_parse", "Parser threw on incoming SMS: ${e.stackTraceToString().take(2000)}")
            return
        }
        if (parsed == null && voucherSent == null && exchangePayoutSent == null) {
            // Most SMS on this phone are personal texts/OTPs and are correctly
            // ignored here — logging every one of those would flood
            // Diagnostics and leak their content. But an SMS that *looks*
            // like a payment confirmation (mentions money/a provider keyword)
            // yet matched no parser is exactly the failure mode "some payment
            // SMS aren't picked up" describes — e.g. a provider slightly
            // changed their message wording, or (Amtel) a provider with no
            // parser registered at all (see PaymentSmsParsers.kt). Previously
            // this was only written to the LOCAL Diagnostics log and then
            // dropped — invisible to the backend/admin dashboard, so a real
            // customer payment in an unrecognized format vanished with no
            // audit trail anywhere a Super Admin could see it, and the order
            // it belonged to was left stuck 'pending' forever with nothing to
            // explain why. Uploading it unparsed (amount/phone left null,
            // same as any other unmatched SMS) puts the raw sender/body in
            // the backend's SMS Logs instead, where match_failure_reason
            // already explains it as unmatched — giving staff a real captured
            // sample to write a correct parser from, instead of guessing.
            if (looksLikePaymentSms(body)) {
                DiagnosticsLog.record(
                    "sms_receiver_unrecognized",
                    "Payment-looking SMS from '$sender' matched no parser — uploading unparsed for visibility: ${body.take(160)}",
                )
                val simSlot = resolveSimSlot(context, intent)
                val unparsedEntry = SmsLogEntry(sender = sender, body = body, receivedAt = receivedAt, simSlot = simSlot)
                val pendingResult = goAsync()
                val appContext = context.applicationContext
                CoroutineScope(Dispatchers.IO).launch {
                    try {
                        if (SmsUploadFlow.uploadAndProcess(appContext, unparsedEntry) is UploadOutcome.RetryableUpload) {
                            PendingActionQueue.enqueue(
                                id = UUID.randomUUID().toString(),
                                type = PendingActionQueue.Type.SMS_UPLOAD,
                                payload = SmsUploadAction(unparsedEntry),
                            )
                        }
                    } catch (e: Exception) {
                        DiagnosticsLog.record("sms_receiver_process", "Failed uploading unparsed payment SMS: ${e.stackTraceToString().take(2000)}")
                    } finally {
                        pendingResult.finish()
                    }
                }
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
                    // Same "same SMS, two purposes" dual-upload as
                    // exchangePayoutSent below: this exact message ("[-E-Voucher-]
                    // Waxaad $X ugu shubtay <phone>, Haraagaagu waa $Y.") also
                    // carries Hormuud's own remaining Send Data balance in its
                    // "Haraagaagu waa" phrase, which only the generic SMS
                    // pipeline's balance detection (resolveBalanceProvider,
                    // simBalances.ts) ever looks at. Routing exclusively through
                    // reportVoucherConfirmation above (added in ebf03d8, before
                    // the Balance Dashboard existed) meant that balance figure
                    // never reached the backend at all -- confirmed live, this
                    // is why Hormuud's own Send Data balance went dark.
                    //
                    // parsedProvider/parsedAmount/parsedPhone are deliberately
                    // left null here, unlike withdrawalPayoutEntry below --
                    // voucherSent.receiverPhone is the phone this SIM just
                    // topped up, which in the normal fulfillment flow is
                    // routinely the SAME number as a real order's own
                    // sender_phone (the USSD top-up that follows a verified
                    // payment recharges the paying customer's own phone).
                    // Passing it through as parsedPhone would feed
                    // findMatchingOrder/findMatchingExchangeOrder/
                    // findMatchingResellerDeposit/findMatchingResellerWithdrawal/
                    // findMatchingVipNumberOrder/matchOrCreateOfflineAutoOrder an
                    // amount+phone pair that could coincidentally match a
                    // DIFFERENT customer's unrelated pending order -- every one
                    // of those matchers no-ops immediately when parsedAmount/
                    // parsedPhone is null (confirmed in each one's own guard
                    // clause), which is exactly what an outgoing delivery
                    // confirmation (not an incoming payment) must do. Balance
                    // detection needs none of these three fields -- it parses
                    // the balance straight from body.
                    val voucherUploadEntry = SmsLogEntry(
                        sender = sender,
                        body = body,
                        receivedAt = receivedAt,
                        simSlot = resolvedSimSlot,
                    )
                    if (SmsUploadFlow.uploadAndProcess(appContext, voucherUploadEntry) is UploadOutcome.RetryableUpload) {
                        PendingActionQueue.enqueue(
                            id = UUID.randomUUID().toString(),
                            type = PendingActionQueue.Type.SMS_UPLOAD,
                            payload = SmsUploadAction(voucherUploadEntry),
                        )
                    }
                    return@launch
                }
                if (exchangePayoutSent != null) {
                    // Money Exchange's own outgoing-confirmation half — the
                    // payout wallet's SIM sent money out and the carrier
                    // confirmed it back; a corroborating signal alongside
                    // ExchangeUssdOrchestrator's own step2 report.
                    if (SmsUploadFlow.reportExchangePayoutConfirmation(exchangePayoutSent) is UploadOutcome.RetryableUpload) {
                        PendingActionQueue.enqueue(
                            id = UUID.randomUUID().toString(),
                            type = PendingActionQueue.Type.EXCHANGE_PAYOUT_CONFIRMATION,
                            payload = ExchangePayoutConfirmationAction(exchangePayoutSent),
                        )
                    }
                    // Reseller Withdraw's payout-sent SMS is the exact same
                    // outgoing shape ("$X ayaad uwareejisay ..."/"Dollar ayad u
                    // warejisay ...") as a Money Exchange payout confirmation,
                    // with no parser of its own — this device can't tell which
                    // one a given SMS confirms without checking in-flight rows,
                    // and only the backend has those. So this same parsed entry
                    // is also uploaded through the generic SMS pipeline
                    // (POST /agent/sms-logs) to give findMatchingResellerWithdrawal
                    // (resellerSmsMatching.ts) a chance at it — a no-op there
                    // unless amount+phone+company also match a 'reserved'/'sent'
                    // withdrawal, so a real Exchange payout is never mistaken
                    // for a Reseller Withdraw one. This is what lets a Reserved
                    // withdrawal actually reach Completed and deduct the
                    // wallet — without this upload, the confirmation SMS was
                    // only ever reported to the Exchange-only endpoint above
                    // and reseller_withdrawals had nothing to ever match on.
                    val withdrawalPayoutEntry = SmsLogEntry(
                        sender = sender,
                        body = body,
                        parsedProvider = exchangePayoutSent.provider,
                        parsedAmount = exchangePayoutSent.amount,
                        parsedPhone = exchangePayoutSent.receiverPhone,
                        receivedAt = receivedAt,
                        simSlot = resolvedSimSlot,
                    )
                    if (SmsUploadFlow.uploadAndProcess(appContext, withdrawalPayoutEntry) is UploadOutcome.RetryableUpload) {
                        PendingActionQueue.enqueue(
                            id = UUID.randomUUID().toString(),
                            type = PendingActionQueue.Type.SMS_UPLOAD,
                            payload = SmsUploadAction(withdrawalPayoutEntry),
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
                    is UploadOutcome.RetryableVerify -> {
                        // Already durably queued by SmsUploadFlow.processMatched
                        // itself (a deterministic "verify_$orderId" id) before it
                        // even attempted the verify+dial chain — enqueuing here
                        // too would create a second, differently-keyed duplicate
                        // entry for the same order.
                    }
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

/**
 * Which physical SIM slot (1 or 2) received this SMS, for payment-number
 * verification on a dual-SIM payment device (see SmsLogEntry.simSlot) — a
 * payment device's two SIMs each have their own payment number (e.g. EVC
 * Plus vs eDahab), so knowing only the device isn't enough to tell which
 * one a given confirmation SMS actually landed on.
 *
 * Android's SMS_RECEIVED broadcast carries a "subscription" extra (the
 * subscriptionId that received it) on dual-SIM devices since Android 5.1 —
 * not officially part of the public Intent contract, but the standard AOSP
 * extra every major OEM has shipped for a decade, and the only source for
 * this information short of manufacturer-specific APIs. Resolved to a
 * 1-based slot index (matching ussd_templates.sim_slot's existing
 * convention) via SubscriptionManager. Retries once after a short delay if
 * unresolved — confirmed live on a real device that SubscriptionManager can
 * transiently report no active subscription for an instant right after
 * delivery (~6% of incoming payment SMS across both SIM slots over a 48h
 * sample) — then returns null — never throws, never guesses — on anything
 * that still doesn't work (single-SIM device, missing READ_PHONE_STATE, no
 * subscription extra on this OEM/API level); the backend falls back to
 * device-level-only matching in that case rather than losing the payment
 * match entirely.
 */
private fun resolveSimSlot(context: Context, intent: Intent): Int? {
    resolveSimSlotOnce(context, intent)?.let { return it }
    Thread.sleep(SIM_SLOT_RETRY_DELAY_MS)
    return resolveSimSlotOnce(context, intent)
}

private const val SIM_SLOT_RETRY_DELAY_MS = 300L

private fun resolveSimSlotOnce(context: Context, intent: Intent): Int? {
    return try {
        val subscriptionId = intent.extras?.getInt("subscription", -1) ?: -1
        if (subscriptionId <= 0) return null
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            return null
        }
        val subscriptionManager = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as? SubscriptionManager ?: return null
        @Suppress("MissingPermission")
        val info = subscriptionManager.getActiveSubscriptionInfo(subscriptionId) ?: return null
        info.simSlotIndex + 1 // AOSP reports 0-based; convert once here so every downstream consumer only ever sees 1-based slots
    } catch (e: Exception) {
        DiagnosticsLog.record("sms_receiver_sim_slot", "Failed to resolve SIM slot: ${e.message}", isError = false)
        null
    }
}

/** Cheap heuristic, not a parser — used only to decide whether an
 * unrecognized SMS is worth a diagnostics entry (see the unparsed-SMS branch
 * above) without logging every ordinary personal text/OTP that passes
 * through this receiver. */
// "haraagaagu" (double-a, ends in "u") is Somtel's "Reseller"-sender
// transfer-confirmation SMS's own spelling ("Yaasiin, waxaad ku
// guulaysatay inaad lambarkan <phone> u wareejiso $X ... Haraagaagu waa:
// $Y. Mahadsanid!"), distinct from "haraagagu"/"haraagaaga" already listed
// -- and that message has no "$" sign either, so it matched NONE of the
// keywords below. Confirmed live: it was being silently dropped here (not
// even uploaded unparsed) before ever reaching the backend, so Somtel's
// own Send Data balance never had a chance to update.
private val PAYMENT_LOOKING_KEYWORDS = listOf(
    "heshay", "ka heshay", "dollar", "aqanoosiga", "edahab", "e-dahab",
    "evcplus", "evc plus", "somnet", "haraagagu", "haraagaaga", "haraagaagu", "amtel",
)

private fun looksLikePaymentSms(body: String): Boolean {
    val lower = body.lowercase()
    return lower.contains("$") || PAYMENT_LOOKING_KEYWORDS.any { lower.contains(it) }
}
