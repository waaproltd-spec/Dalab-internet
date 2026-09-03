package com.dalab.internet.notifications

import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.dalab.internet.MainActivity
import com.dalab.internet.R
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.RegisterDeviceTokenRequest
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Delivers a "customer needs help" push (support.routes.ts's
 * notifyAssignedAgent()) even while this app is backgrounded, minimized, the
 * agent is in another app entirely, or the screen is locked -- that's a
 * property of the Android/FCM notification channel itself (IMPORTANCE_HIGH,
 * created in DalabAgentApp.onCreate() before any push can possibly arrive),
 * not something this class has to implement.
 *
 * onMessageReceived() only actually fires while this app's process is alive
 * and in the FOREGROUND -- for background/killed states, the OS shows the
 * notification automatically straight from the FCM payload (see push.ts,
 * which always sends both a `notification` and a `data` block for exactly
 * this reason), so building one here too would double it up. This exists
 * purely to cover the foreground case: an agent already inside this app
 * (e.g. on the Orders tab) still gets notified of a new support request
 * without having to be staring at the Support screen.
 */
class AgentFcmService : FirebaseMessagingService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        scope.launch {
            try {
                ApiClient.service.registerAgentDeviceToken(RegisterDeviceTokenRequest(token))
            } catch (e: Exception) {
                DiagnosticsLog.record("fcm_token_refresh", "Failed to register rotated token: ${e.message}")
            }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["title"] ?: return
        val body = message.notification?.body ?: message.data["body"] ?: ""
        val conversationId = message.data["conversationId"]
        val isOrdersPush = message.data["screen"] == "agent_orders"

        // Every support push (a fresh assignment or a customer's follow-up
        // message -- see support.routes.ts's notifyAssignedAgent()/
        // notifyAgentOfNewMessage()) means there's an unread customer message
        // waiting in the Support tab. Set unconditionally, before the
        // POST_NOTIFICATIONS check below -- the in-app badge must still work
        // even if the system-tray notification itself couldn't be shown.
        if (message.data["screen"] == "support_conversation") {
            SupportUnreadState.markUnread()
        }

        // A payment-confirmed Shop/VIP order (shop.routes.ts/
        // vipNumbers.routes.ts/vipNumberPackages.routes.ts's
        // sendPushToAllAgents()) has no single assigned agent and no
        // in-app unread badge to set -- the real order list itself, once
        // opened, is the source of truth. This just gets the tap to land on
        // the Orders tab instead of wherever the app happened to be.
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (isOrdersPush) {
                putExtra(MainActivity.EXTRA_OPEN_ORDERS, true)
            } else {
                putExtra(MainActivity.EXTRA_OPEN_SUPPORT, true)
            }
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            conversationId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // Orders pushes default to the "dalab_updates" channel (push.ts's own
        // default, created in DalabAgentApp) -- support pushes keep their
        // existing dedicated channel/id so this change can't affect their
        // behavior at all.
        val channelId = if (isOrdersPush) ORDERS_CHANNEL_ID else SUPPORT_CHANNEL_ID
        val notificationId = if (isOrdersPush) ORDERS_NOTIFICATION_ID else SUPPORT_NOTIFICATION_ID

        val notification = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        try {
            NotificationManagerCompat.from(this).notify(notificationId, notification)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS not granted (Android 13+) -- the push still
            // arrived and the app can still be opened normally, it just
            // won't surface in the system tray until the agent grants it.
            DiagnosticsLog.record("fcm_notification_show", "Missing POST_NOTIFICATIONS: ${e.message}")
        }
    }

    companion object {
        const val SUPPORT_CHANNEL_ID = "support_requests"
        const val ORDERS_CHANNEL_ID = "dalab_updates"
        private const val SUPPORT_NOTIFICATION_ID = 4821
        private const val ORDERS_NOTIFICATION_ID = 4822
    }
}
