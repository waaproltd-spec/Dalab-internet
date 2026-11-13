package com.dalab.internet.ussd

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.dalab.internet.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * While the Agent App is dialing USSD, a quiet notification asks the phone's
 * owner not to start their own USSD until it's done (two sessions at once
 * break each other). Removed as soon as the app's session ends.
 */
object UssdActivityNotifier {
    private const val CHANNEL = "ussd_activity"
    private const val ID = 0x55D
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    fun init(context: Context) {
        val app = context.applicationContext
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "USSD in progress", NotificationManager.IMPORTANCE_LOW))
        }
        scope.launch {
            var shown = false
            UssdSimLock.status.collect { s ->
                val run = s.running
                try {
                    if (run != null && s.phoneBusy == null) {
                        val n = NotificationCompat.Builder(app, CHANNEL)
                            .setSmallIcon(R.drawable.ic_notification)
                            .setContentTitle("AGENT APP is using USSD")
                            .setContentText("${run.label} on SIM ${run.simSlot} — please wait before dialing USSD yourself.")
                            .setOngoing(true)
                            .setOnlyAlertOnce(true)
                            .setPriority(NotificationCompat.PRIORITY_LOW)
                            .build()
                        NotificationManagerCompat.from(app).notify(ID, n)
                        shown = true
                    } else if (shown) {
                        NotificationManagerCompat.from(app).cancel(ID)
                        shown = false
                    }
                } catch (_: SecurityException) {
                    // Notifications not allowed on this phone: nothing to show.
                }
            }
        }
    }
}
