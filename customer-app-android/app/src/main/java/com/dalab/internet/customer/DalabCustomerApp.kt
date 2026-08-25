package com.dalab.internet.customer

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.notifications.CustomerFcmService
import com.dalab.internet.customer.notifications.NotificationsBadgeState
import com.dalab.internet.customer.prefs.LocalizationManager
import com.dalab.internet.customer.prefs.ThemeManager
import com.dalab.internet.customer.queue.PendingActionQueue

class DalabCustomerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        SessionManager.init(this)
        PendingActionQueue.init(this)
        ThemeManager.init(this)
        LocalizationManager.init(this)
        NotificationsBadgeState.init(this)
        // Created here (Application.onCreate -- guaranteed to run before any
        // component, including CustomerFcmService) rather than in
        // MainActivity, so the channel already exists even if a push
        // arrives before the customer has ever opened a screen this cold start.
        createUpdatesNotificationChannel()
    }

    private fun createUpdatesNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CustomerFcmService.UPDATES_CHANNEL_ID,
                "Order & exchange updates",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Status updates for your Internet Store orders and Money Exchange"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 250, 150, 250)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
}
