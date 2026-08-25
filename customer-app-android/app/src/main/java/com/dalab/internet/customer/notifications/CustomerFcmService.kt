package com.dalab.internet.customer.notifications

import android.app.PendingIntent
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.dalab.internet.customer.MainActivity
import com.dalab.internet.customer.R
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Delivers an order/exchange status push (customerNotify.ts/push.ts) even
 * while this app is backgrounded, minimized, or the screen is locked --
 * that's a property of the "dalab_updates" notification channel itself
 * (created in DalabCustomerApp.onCreate() before any push can possibly
 * arrive), not something this class has to implement.
 *
 * onMessageReceived() only actually fires while this app's process is alive
 * and in the FOREGROUND -- for background/killed states, the OS shows the
 * notification automatically straight from the FCM payload (see push.ts,
 * which always sends both a `notification` and a `data` block for exactly
 * this reason), so building one here too would double it up. This exists
 * purely to cover the foreground case: a customer already inside this app
 * still gets notified without having to be staring at the Exchange Status
 * screen's live SSE connection.
 */
class CustomerFcmService : FirebaseMessagingService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        scope.launch {
            try {
                PushTokenRegistrar.registerIfNeeded(applicationContext)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to register rotated token: ${e.message}")
            }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["title"] ?: return
        val body = message.notification?.body ?: message.data["body"] ?: ""

        NotificationsBadgeState.bumpForIncomingPush()

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_OPEN_NOTIFICATIONS, true)
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            message.data["notificationId"]?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(this, UPDATES_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        try {
            NotificationManagerCompat.from(this).notify(UPDATES_NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS not granted (Android 13+) -- the push still
            // arrived (the badge above already reflects it) and the app can
            // still be opened normally, it just won't surface in the system
            // tray until the customer grants it.
            Log.w(TAG, "Missing POST_NOTIFICATIONS: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "CustomerFcmService"
        const val UPDATES_CHANNEL_ID = "dalab_updates"
        private const val UPDATES_NOTIFICATION_ID = 5821
    }
}
