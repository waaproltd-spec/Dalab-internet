package com.dalab.internet.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.dalab.internet.MainActivity
import com.dalab.internet.R
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.HeartbeatRequest
import com.dalab.internet.network.RealtimeClient
import com.dalab.internet.ussd.UssdDialer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Keeps two things alive independent of which screen is on top or whether the
 * screen is locked: the SSE order-stream connection (previously tied to
 * OrdersListScreen's composition lifecycle, so it silently died the moment
 * the agent navigated away) and a ~60s health heartbeat reporting this
 * device's battery/network/SIM-presence to the backend so the Super Admin
 * dashboard — and this device's own SIM-routing priority logic — can see
 * when it goes unhealthy.
 *
 * Started from MainActivity right after login (and from BootReceiver if a
 * session already exists after a reboot); stopped on logout.
 */
class AgentBackgroundService : Service() {

    private var scope: CoroutineScope? = null
    private var realtimeClient: RealtimeClient? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildNotification())

        val newScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope = newScope

        realtimeClient = RealtimeClient(path = "agent/orders/stream") {
            AgentEventBus.emitOrderEvent()
        }.also { it.connect() }

        newScope.launch { heartbeatLoop() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        realtimeClient?.disconnect()
        realtimeClient = null
        scope?.cancel()
        scope = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private suspend fun heartbeatLoop() {
        val currentScope = scope ?: return
        while (currentScope.isActive) {
            val deviceId = DeviceIdentity.deviceId()
            if (deviceId != null && SessionManager.isLoggedIn()) {
                try {
                    ApiClient.service.sendHeartbeat(deviceId, buildHeartbeat())
                } catch (_: Exception) {
                    // Best-effort — the next tick tries again; a dropped heartbeat
                    // just shows as a stale "last seen" on the dashboard.
                }
            }
            delay(HEARTBEAT_INTERVAL_MS)
        }
    }

    private fun buildHeartbeat(): HeartbeatRequest {
        val battery = readBatteryPercent()
        val online = isNetworkOnline()
        val sims = UssdDialer(this).listActiveSims()
        val sim1Present = sims.any { it.simSlotIndex == 0 }
        val sim2Present = sims.any { it.simSlotIndex == 1 }
        return HeartbeatRequest(
            batteryPercent = battery,
            networkOnline = online,
            sim1Present = sim1Present,
            sim2Present = sim2Present,
        )
    }

    private fun readBatteryPercent(): Int? {
        val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level < 0 || scale <= 0) return null
        return (level * 100) / scale
    }

    private fun isNetworkOnline(): Boolean {
        val connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "Agent monitoring", NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }

        val openApp = android.app.PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            android.app.PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("DALAB Agent")
            .setContentText("Monitoring payments and orders")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(openApp)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "agent_background_channel"
        private const val NOTIFICATION_ID = 1001
        private const val HEARTBEAT_INTERVAL_MS = 60_000L

        fun start(context: Context) {
            val intent = Intent(context, AgentBackgroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AgentBackgroundService::class.java))
        }
    }
}
