package com.dalab.internet.ussd

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.dalab.internet.MainActivity
import com.dalab.internet.R
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.notifications.AgentFcmService
import com.dalab.internet.ui.i18n.tr
import org.json.JSONObject
import retrofit2.Response

/**
 * Insufficient SIM Balance alert (backend: utils/simBalanceCheck.ts).
 *
 * The backend refuses to start a dial when the company SIM can't cover the
 * order -- 409 with code "insufficient_sim_balance", or
 * "sim_balance_unverified" when the balance is unknown/outdated and the
 * agent hasn't confirmed. [refusalFrom] turns that reply into a terminal
 * [DialResult] so nothing is dialed; [notifyBlocked] tells the agent when an
 * automatic dial (SMS-matched / self-heal) was stopped, since no screen is
 * open to show it.
 */
object SimBalanceAlerts {
    const val CODE_INSUFFICIENT = "insufficient_sim_balance"
    const val CODE_UNVERIFIED = "sim_balance_unverified"

    /** The balance refusal in a dial-attempt start reply, or null if it's anything else. */
    fun refusalFrom(response: Response<*>): DialResult? {
        if (response.isSuccessful || response.code() != 409) return null
        return try {
            val json = JSONObject(response.errorBody()?.string() ?: return null)
            refusalFromJson(json.optString("code"), json.optString("error"))
        } catch (_: Exception) {
            null
        }
    }

    /** Pure mapping from the server's code + message (unit-tested). */
    fun refusalFromJson(code: String?, message: String?): DialResult? = when (code) {
        CODE_INSUFFICIENT -> DialResult(DialOutcome.INSUFFICIENT_SIM_BALANCE, message?.takeIf { it.isNotBlank() } ?: "Insufficient SIM Balance. Please recharge the company SIM and try again.")
        CODE_UNVERIFIED -> DialResult(DialOutcome.SIM_BALANCE_UNVERIFIED, message?.takeIf { it.isNotBlank() } ?: "The company SIM balance is unknown or outdated. Check it before processing this order.")
        else -> null
    }

    /**
     * Title with the company name, from the server's message: "Insufficient
     * SIM Balance — Hormuud. The customer requested ..." -> "Insufficient SIM
     * Balance — Hormuud". Falls back to a plain title for any other wording.
     */
    fun titleFor(result: DialResult): String {
        val message = result.responseMessage.orEmpty()
        val head = message.substringBefore(". ", missingDelimiterValue = "").trim()
        if (head.contains(" — ")) return head
        return if (result.outcome == DialOutcome.INSUFFICIENT_SIM_BALANCE) "Insufficient SIM Balance" else "Check SIM Balance"
    }

    // Order id -> the alert already shown for it. The automatic retries
    // (self-heal sweep, SMS re-match) hit the same refusal again and again
    // until the SIM is recharged; only a NEW problem for an order (a
    // different outcome or missing amount) may alert the agent again.
    private val alerted = java.util.concurrent.ConcurrentHashMap<String, String>()

    /** True when this exact alert hasn't been shown for this order yet (unit-tested). */
    fun shouldAlert(orderId: String, result: DialResult): Boolean {
        val key = "${result.outcome}|${result.responseMessage}"
        return alerted.put(orderId, key) != key
    }

    /** The order dialed (or the problem was cleared): a future refusal alerts again. */
    fun clear(orderId: String) {
        alerted.remove(orderId)
    }

    fun notifyBlocked(context: Context, orderId: String, result: DialResult) {
        if (!shouldAlert(orderId, result)) return
        val title = titleFor(result)
        val text = tr(result.responseMessage.orEmpty())
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_OPEN_ORDERS, true)
            putExtra(MainActivity.EXTRA_ORDER_ID, orderId)
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            ("simbal:$orderId").hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, AgentFcmService.ORDERS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("${tr(title)} · $orderId")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            // One notification per order: a later automatic retry that's
            // still blocked updates it silently instead of alerting again.
            .setOnlyAlertOnce(true)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(("simbal:$orderId").hashCode(), notification)
        } catch (e: SecurityException) {
            DiagnosticsLog.record("sim_balance_notify", "Missing POST_NOTIFICATIONS: ${e.message}")
        }
    }
}
