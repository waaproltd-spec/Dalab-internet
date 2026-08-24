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

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_OPEN_SUPPORT, true)
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            conversationId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(this, SUPPORT_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        try {
            NotificationManagerCompat.from(this).notify(SUPPORT_NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS not granted (Android 13+) -- the push still
            // arrived and the app can still be opened normally, it just
            // won't surface in the system tray until the agent grants it.
            DiagnosticsLog.record("fcm_notification_show", "Missing POST_NOTIFICATIONS: ${e.message}")
        }
    }

    companion object {
        const val SUPPORT_CHANNEL_ID = "support_requests"
        private const val SUPPORT_NOTIFICATION_ID = 4821
    }
}
