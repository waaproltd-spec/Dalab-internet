package com.dalab.internet.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.dalab.internet.MainActivity
import com.dalab.internet.R
import com.dalab.internet.network.ApiClient
import com.dalab.internet.ussd.DialOutcome
import com.dalab.internet.ussd.UssdOrchestrator
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
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val uploadResponse = ApiClient.service.uploadSmsLog(parsed)
                val smsLogId = uploadResponse.body()?.id
                val matchedOrderId = uploadResponse.body()?.matchedOrderId
                val requiresManualApproval = uploadResponse.body()?.requiresManualApproval ?: false

                if (matchedOrderId != null && requiresManualApproval) {
                    // A Super Admin has turned off automation for this order's
                    // provider — don't auto-dial, just point the agent at it.
                    notifyManualApprovalNeeded(context, matchedOrderId, parsed.parsedAmount)
                } else if (matchedOrderId != null) {
                    val orchestrator = UssdOrchestrator(context)
                    val result = orchestrator.processMatchedOrder(matchedOrderId, smsLogId)
                    notifyAgent(context, matchedOrderId, parsed.parsedAmount, result.outcome, result.responseMessage)
                }
            } catch (_: Exception) {
                // Offline or server unreachable — the SMS is still logged locally in
                // SmsListenerState so the agent can retry from the Orders screen, and
                // nothing here should ever crash the receiver.
            } finally {
                pendingResult.finish()
            }
        }
    }

    private fun notifyManualApprovalNeeded(context: Context, orderId: String, amount: Double?) {
        val openIntent = Intent(context, MainActivity::class.java).apply {
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
        val openIntent = Intent(context, MainActivity::class.java).apply {
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
