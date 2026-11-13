package com.dalab.internet.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.SoundPool
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.dalab.internet.MainActivity
import com.dalab.internet.R
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.ui.theme.AgentSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * WhatsApp-style alerts for Agent Support: one short tone per incoming
 * customer message or help request, a notification with the customer's name
 * and a message preview, and nothing at all for the agent's own messages.
 *
 * Two sources feed this, and either may arrive first for the same message:
 *  - the live SSE stream (AgentBackgroundService keeps it connected while
 *    the app is open, in the background, or the phone is locked) -- see
 *    [onRealtimeEvent];
 *  - an FCM data push from the backend (also covers the app being killed,
 *    once Firebase is configured for this app) -- see [onPush].
 * Both are keyed by the message id, so whichever comes second is dropped:
 * exactly one sound per message.
 *
 * What the agent hears:
 *  - viewing that same conversation right now -> a soft in-app "pop" only,
 *    no notification;
 *  - anywhere else (another screen, another app, phone locked) -> a
 *    notification on [MESSAGES_CHANNEL_ID], whose channel sound is the short
 *    two-note tone in res/raw/support_message.wav;
 *  - sounds turned off (More → Notifications) -> the same notification on
 *    the silent [MESSAGES_SILENT_CHANNEL_ID], and no in-app pop.
 */
object SupportAlerts {
    const val MESSAGES_CHANNEL_ID = "support_messages_v1"
    const val MESSAGES_SILENT_CHANNEL_ID = "support_messages_silent_v1"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var appContext: Context

    /** One notification/sound per event, however often it's delivered. */
    private val deduper = AlertDeduper()

    /** The conversation whose chat is on screen right now (set by SupportScreen
     * while it's resumed), or null. */
    @Volatile
    var visibleConversationId: String? = null
        private set

    private var soundPool: SoundPool? = null
    private var softSoundId = 0
    private var softSoundLoaded = false

    fun init(context: Context) {
        appContext = context.applicationContext
        createChannels(appContext)
    }

    private fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val toneUri = Uri.parse("${ContentResolver.SCHEME_ANDROID_RESOURCE}://${context.packageName}/${R.raw.support_message}")
        val withSound = NotificationChannel(MESSAGES_CHANNEL_ID, "Customer messages", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "New Agent Support messages and customers asking for help"
            setSound(
                toneUri,
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 120, 80, 120)
        }
        val silent = NotificationChannel(MESSAGES_SILENT_CHANNEL_ID, "Customer messages (silent)", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Used when Agent Support sounds are turned off"
            setSound(null, null)
            enableVibration(false)
        }
        manager.createNotificationChannel(withSound)
        manager.createNotificationChannel(silent)
    }

    /** SupportScreen calls this while a conversation's chat is visible
     * (and with null once it isn't); it also clears that customer's
     * notification, like opening a WhatsApp chat does. */
    fun setVisibleConversation(conversationId: String?) {
        visibleConversationId = conversationId
        if (conversationId != null && ::appContext.isInitialized) {
            NotificationManagerCompat.from(appContext).cancel(notificationIdFor(conversationId))
        }
    }

    /** An FCM data push from support.routes.ts (notifyAgentOfNewMessage /
     * notifyAssignedAgent / notifyOnlineAgentsOfWaitingCustomer). */
    fun onPush(data: Map<String, String>, fallbackTitle: String?, fallbackBody: String?) {
        val conversationId = data["conversationId"] ?: return
        // DALAB's backend sends just {screen, conversationId} with a generic
        // title/body: look the conversation up (as for a legacy live event)
        // so the alert has the customer's name and real message, keyed by
        // the message's own id -- never a generic text that would make every
        // later message in the chat look like a repeat.
        if (data["alert"] == null && data["messageId"] == null) {
            onLegacyEvent(conversationId)
            return
        }
        val alert = data["alert"] ?: "message"
        val key = AlertDeduper.keyFor(alert, conversationId, data["messageId"], data["preview"] ?: fallbackBody)
        if (!deduper.markSeen(key)) return
        val name = data["customerName"]?.takeIf { it.isNotBlank() } ?: fallbackTitle ?: "Customer"
        val preview = data["preview"]?.takeIf { it.isNotBlank() } ?: fallbackBody.orEmpty()
        deliver(alert, conversationId, name, preview)
    }

    /** One raw SSE `data:` payload from the agent stream. Only
     * support_conversation.updated events with an `alert` are of interest;
     * everything else (orders, the agent's own messages) is ignored here. */
    fun onRealtimeEvent(rawData: String) {
        val event = try {
            JSONObject(rawData)
        } catch (_: Exception) {
            return
        }
        if (event.optString("type") != "support_conversation.updated") return
        if (event.optString("senderType") == "agent") return
        val conversationId = event.optString("conversationId").takeIf { it.isNotBlank() } ?: return
        val alert = event.optString("alert").takeIf { it.isNotBlank() } ?: run {
            // A server that predates the `alert` field sends only
            // {type, conversationId} -- work out from the conversation itself
            // whether this is a new request/message for this agent.
            onLegacyEvent(conversationId)
            return
        }
        val messageId = event.optString("messageId").takeIf { it.isNotBlank() }
        val key = AlertDeduper.keyFor(alert, conversationId, messageId)
        if (deduper.isSeen(key)) return

        // The stream goes to every agent: confirm this one is actually for
        // us, and get the customer's name + preview, before alerting.
        scope.launch {
            try {
                val status = ApiClient.service.getSupportStatus().body() ?: return@launch
                when (alert) {
                    "message", "assigned" -> {
                        if (status.activeConversationId != conversationId) return@launch
                        val conversation = ApiClient.service.getSupportConversation(conversationId).body() ?: return@launch
                        val message = messageId?.let { id -> conversation.messages.firstOrNull { it.id == id } }
                            ?: conversation.messages.lastOrNull { it.senderType == "customer" }
                        if (message?.senderType == "agent") return@launch
                        if (!deduper.markSeen(key)) return@launch
                        deliver(alert, conversationId, displayName(conversation.customerName, conversation.customerPhone), previewOf(message))
                    }
                    "waiting" -> {
                        if (!status.online || status.activeConversationId != null) return@launch
                        val waiting = ApiClient.service.getSupportQueue().body().orEmpty().firstOrNull { it.id == conversationId }
                            ?: return@launch
                        if (!deduper.markSeen(key)) return@launch
                        deliver(alert, conversationId, displayName(waiting.customerName, waiting.customerPhone), waiting.firstMessage.orEmpty().take(90))
                    }
                }
            } catch (e: Exception) {
                DiagnosticsLog.record("support_alert_realtime", "Couldn't check support event: ${e.message}")
            }
        }
    }

    /**
     * Fallback for support events without an `alert` field (older backend):
     * the conversation is fetched and [LegacyAlertDecider] decides whether
     * something genuinely new happened for this agent -- a recent
     * assignment, a recent customer message, or a recent waiting customer.
     * Keys are the same stable ids the new path uses, so it never doubles up
     * with a push or a repeated event.
     */
    private fun onLegacyEvent(conversationId: String) {
        scope.launch {
            try {
                val status = ApiClient.service.getSupportStatus().body() ?: return@launch
                val now = System.currentTimeMillis()
                if (status.activeConversationId == conversationId) {
                    val conversation = ApiClient.service.getSupportConversation(conversationId).body() ?: return@launch
                    val latest = conversation.messages.lastOrNull { it.senderType == "customer" }
                    val decision = LegacyAlertDecider.forActiveConversation(
                        conversationId = conversationId,
                        assignedAtMs = com.dalab.internet.util.parseApiDate(conversation.assignedAt)?.time,
                        latestCustomerMessageId = latest?.id,
                        latestCustomerMessageAtMs = com.dalab.internet.util.parseApiDate(latest?.createdAt)?.time,
                        nowMs = now,
                    ) ?: return@launch
                    if (!deduper.markSeen(decision.key)) return@launch
                    latest?.id?.let { deduper.markSeen(it) }
                    deliver(decision.alert, conversationId, displayName(conversation.customerName, conversation.customerPhone), previewOf(latest))
                } else if (status.online && status.activeConversationId == null) {
                    val waiting = ApiClient.service.getSupportQueue().body().orEmpty().firstOrNull { it.id == conversationId } ?: return@launch
                    val decision = LegacyAlertDecider.forWaiting(
                        conversationId,
                        com.dalab.internet.util.parseApiDate(waiting.createdAt)?.time,
                        now,
                    ) ?: return@launch
                    if (!deduper.markSeen(decision.key)) return@launch
                    deliver(decision.alert, conversationId, displayName(waiting.customerName, waiting.customerPhone), waiting.firstMessage.orEmpty().take(90))
                }
            } catch (e: Exception) {
                DiagnosticsLog.record("support_alert_realtime", "Couldn't check support event: ${e.message}")
            }
        }
    }

    /** More → Notifications → "Test alert": the real channel, tone and
     * heads-up banner, so the agent can confirm sound/permission on this phone. */
    fun sendTestAlert() {
        deliver("assigned", "test-alert", "Test customer", "This is how a new Agent Support request will sound.")
    }

    private fun deliver(alert: String, conversationId: String, customerName: String, preview: String) {
        if (!::appContext.isInitialized) return
        val soundsOn = AgentSettings.supportSounds

        if (alert == "message" && visibleConversationId == conversationId) {
            // Already looking at this chat: just a subtle cue, like WhatsApp.
            if (soundsOn) playSoft()
            return
        }
        SupportUnreadState.markUnread()

        val title = when (alert) {
            "waiting" -> "$customerName is waiting"
            "assigned" -> "$customerName needs help"
            else -> customerName
        }
        val text = preview.ifBlank {
            when (alert) {
                "waiting" -> "A customer is waiting for an agent."
                "assigned" -> "A customer was connected to you."
                else -> "New message"
            }
        }
        val intent = Intent(appContext, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_OPEN_SUPPORT, true)
        }
        val pendingIntent = PendingIntent.getActivity(
            appContext,
            notificationIdFor(conversationId),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(appContext, if (soundsOn) MESSAGES_CHANNEL_ID else MESSAGES_SILENT_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .apply {
                // Below Android 8 there are no channels: sound is set per
                // notification instead.
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                    if (soundsOn) {
                        setSound(Uri.parse("${ContentResolver.SCHEME_ANDROID_RESOURCE}://${appContext.packageName}/${R.raw.support_message}"))
                        setVibrate(longArrayOf(0, 120, 80, 120))
                    } else {
                        setSilent(true)
                    }
                }
            }
            .build()
        try {
            // One notification per customer: a newer message replaces the
            // older one (and still sounds once), like a WhatsApp chat.
            NotificationManagerCompat.from(appContext).notify(notificationIdFor(conversationId), notification)
        } catch (e: SecurityException) {
            DiagnosticsLog.record("support_alert_notify", "Missing POST_NOTIFICATIONS: ${e.message}")
            if (soundsOn) playSoft()
        }
    }

    private fun playSoft() {
        try {
            val audio = appContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            if (audio != null && audio.ringerMode != AudioManager.RINGER_MODE_NORMAL) return
            val pool = soundPool ?: SoundPool.Builder()
                .setMaxStreams(1)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                .build()
                .also { created ->
                    soundPool = created
                    created.setOnLoadCompleteListener { p, id, status ->
                        if (status == 0) {
                            softSoundLoaded = true
                            p.play(id, 0.6f, 0.6f, 1, 0, 1f)
                        }
                    }
                    softSoundId = created.load(appContext, R.raw.support_message_soft, 1)
                }
            if (softSoundLoaded) pool.play(softSoundId, 0.6f, 0.6f, 1, 0, 1f)
        } catch (e: Exception) {
            DiagnosticsLog.record("support_alert_sound", "Couldn't play sound: ${e.message}")
        }
    }

    private fun notificationIdFor(conversationId: String) = 0x5A000000 or (conversationId.hashCode() and 0x00FFFFFF)

    private fun displayName(name: String?, phone: String?): String =
        name?.trim()?.takeIf { it.isNotEmpty() } ?: phone?.let { "+$it" } ?: "Customer"

    private fun previewOf(message: com.dalab.internet.data.SupportMessage?): String = when (message?.messageType) {
        null -> ""
        "image" -> "📷 Photo"
        "voice" -> "🎤 Voice message"
        else -> message.body.orEmpty().replace(Regex("\\s+"), " ").trim().let { if (it.length > 90) it.take(87) + "…" else it }
    }
}
