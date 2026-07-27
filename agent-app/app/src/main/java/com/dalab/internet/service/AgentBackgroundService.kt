package com.dalab.internet.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
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
import com.dalab.internet.queue.QueueDrainer
import com.dalab.internet.ussd.SimRoutingRepository
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
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        startForeground(NOTIFICATION_ID, buildNotification())

        val newScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope = newScope

        realtimeClient = RealtimeClient(path = "agent/orders/stream") {
            AgentEventBus.emitOrderEvent()
        }.also { it.connect() }

        // SimRoutingRepository.refresh() previously had zero call sites anywhere in
        // the app — its cache was never populated on a real install, so simSlotFor()
        // always returned null and UssdOrchestrator always short-circuited to
        // NO_SIM_CONFIGURED. An immediate refresh here (plus the periodic loop below)
        // is what actually makes automatic USSD dialing work.
        newScope.launch { SimRoutingRepository.refresh() }
        newScope.launch { QueueDrainer.drainAll(applicationContext) }

        newScope.launch { heartbeatLoop() }
        newScope.launch { simRoutingRefreshLoop() }
        newScope.launch { queueDrainLoop() }
        registerConnectivityCallback(newScope)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        networkCallback?.let {
            (getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)?.unregisterNetworkCallback(it)
        }
        networkCallback = null
        realtimeClient?.disconnect()
        realtimeClient = null
        scope?.cancel()
        scope = null
        isRunning = false
        super.onDestroy()
    }

    // Immediate drain the moment connectivity comes back, rather than waiting
    // up to a full queueDrainLoop() interval — the periodic loop is only the
    // backstop for connectivity flaps this callback misses.
    private fun registerConnectivityCallback(scope: CoroutineScope) {
        val connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scope.launch { QueueDrainer.drainAll(applicationContext) }
            }
        }
        connectivityManager.registerDefaultNetworkCallback(callback)
        networkCallback = callback
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

    // Routing changes are admin-driven and rare (nothing like heartbeat's need for
    // a 60s cadence), so this runs on its own slower interval rather than piggybacking
    // on every heartbeat tick — a dashboard routing change still takes effect without
    // requiring the agent to restart the app.
    private suspend fun simRoutingRefreshLoop() {
        val currentScope = scope ?: return
        while (currentScope.isActive) {
            delay(SIM_ROUTING_REFRESH_INTERVAL_MS)
            if (DeviceIdentity.isSet() && SessionManager.isLoggedIn()) {
                SimRoutingRepository.refresh()
            }
        }
    }

    // Backstop for connectivity changes the NetworkCallback above misses (e.g.
    // a flap that doesn't cleanly fire onAvailable) — short enough that a
    // queued payment doesn't sit for long, but well above heartbeat's cadence
    // since this is a fallback, not the primary trigger.
    private suspend fun queueDrainLoop() {
        val currentScope = scope ?: return
        while (currentScope.isActive) {
            delay(QUEUE_DRAIN_INTERVAL_MS)
            QueueDrainer.drainAll(applicationContext)
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
        private const val SIM_ROUTING_REFRESH_INTERVAL_MS = 5 * 60_000L
        private const val QUEUE_DRAIN_INTERVAL_MS = 2 * 60_000L

        /** Read from PermissionsStatusScreen to show "Foreground Service: Active/Inactive". */
        @Volatile
        var isRunning: Boolean = false
            private set

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
