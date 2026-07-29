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
import androidx.core.app.NotificationManagerCompat
import com.dalab.internet.MainActivity
import com.dalab.internet.R
import com.dalab.internet.auth.AuthRepository
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.auth.LoginResult
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.diagnostics.DiagnosticsLog
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
 * Started from MainActivity right after device setup/auto-login succeeds
 * (and from BootReceiver if a session already exists after a reboot). There
 * is no logout in this app, so nothing ever explicitly stops it short of the
 * OS killing the process.
 */
class AgentBackgroundService : Service() {

    private var scope: CoroutineScope? = null
    private var realtimeClient: RealtimeClient? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true

        try {
            startForeground(NOTIFICATION_ID, buildNotification())
        } catch (e: Exception) {
            // Real crash class on Android 12+: ForegroundServiceStartNotAllowedException
            // if the OS decides this isn't a valid moment to promote to foreground, or a
            // missing-type exception on 14+. Losing the foreground promotion means the
            // service can be killed sooner under memory pressure, but that's a much
            // better outcome than the whole app crashing here.
            DiagnosticsLog.record("background_service_foreground", "startForeground failed: ${e.stackTraceToString().take(2000)}")
        }

        val newScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope = newScope

        try {
            realtimeClient = RealtimeClient(path = "agent/orders/stream") {
                AgentEventBus.emitOrderEvent()
            }.also { it.connect() }
            newScope.launch {
                realtimeClient?.state?.collect { AgentEventBus.setConnectionState(it) }
            }
        } catch (e: Exception) {
            DiagnosticsLog.record("background_service_realtime", "Failed to start SSE client: ${e.stackTraceToString().take(2000)}")
        }

        // SimRoutingRepository.refresh() previously had zero call sites anywhere in
        // the app — its cache was never populated on a real install, so simSlotFor()
        // always returned null and UssdOrchestrator always short-circuited to
        // NO_SIM_CONFIGURED. An immediate refresh here (plus the periodic loop below)
        // is what actually makes automatic USSD dialing work. refresh() already
        // catches its own exceptions internally and returns a Result, but the
        // loops below still get a defensive try/catch since they run unattended
        // for as long as the service is alive.
        newScope.launch { SimRoutingRepository.refresh() }
        newScope.launch {
            try {
                QueueDrainer.drainAll(applicationContext)
            } catch (e: Exception) {
                DiagnosticsLog.record("background_service_queue_drain", "Initial drain failed: ${e.stackTraceToString().take(2000)}")
            }
        }

        newScope.launch { heartbeatLoop() }
        newScope.launch { simRoutingRefreshLoop() }
        newScope.launch { queueDrainLoop() }
        newScope.launch {
            // There's no login screen to send the agent to anymore, so a dead
            // session first tries to silently re-authenticate itself the same
            // way app startup does (this device's assigned agent) — no
            // interaction needed for the common case (e.g. an admin-triggered
            // token revocation). Only if that also fails (no agent currently
            // assigned to this device) does this surface a notification,
            // since every SMS upload/verify/dial call would otherwise silently
            // 401 forever with nothing telling the agent payments stopped.
            AgentEventBus.sessionExpired.collect {
                val deviceId = DeviceIdentity.deviceId()
                val recovered = deviceId != null && AuthRepository.loginWithDevice(deviceId) is LoginResult.Success
                if (!recovered) notifySessionExpired()
            }
        }
        try {
            registerConnectivityCallback(newScope)
        } catch (e: Exception) {
            DiagnosticsLog.record("background_service_connectivity", "Failed to register network callback: ${e.stackTraceToString().take(2000)}")
        }
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
            try {
                if (DeviceIdentity.isSet() && SessionManager.isLoggedIn()) {
                    SimRoutingRepository.refresh()
                }
            } catch (e: Exception) {
                DiagnosticsLog.record("sim_routing_loop", "Tick failed: ${e.stackTraceToString().take(2000)}")
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
            try {
                QueueDrainer.drainAll(applicationContext)
            } catch (e: Exception) {
                DiagnosticsLog.record("queue_drain_loop", "Tick failed: ${e.stackTraceToString().take(2000)}")
            }
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

    // Posted on "payment_channel" (high-importance, vibrating — set up in
    // MainActivity.createNotificationChannel) rather than this service's own
    // silent monitoring channel, since a dead session means payments have
    // stopped being processed entirely until the agent acts on this.
    private fun notifySessionExpired() {
        DiagnosticsLog.record(
            "session_expired",
            "Session expired and silent re-auth failed — likely no active agent is assigned to this device anymore.",
        )
        val openApp = android.app.PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, "payment_channel")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Action needed: this device isn't signed in")
            .setContentText("Payments are NOT being processed. Ask your Super Admin to assign an active agent to this device.")
            .setContentIntent(openApp)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        NotificationManagerCompat.from(this).notify(SESSION_EXPIRED_NOTIFICATION_ID, notification)
    }

    companion object {
        private const val CHANNEL_ID = "agent_background_channel"
        private const val NOTIFICATION_ID = 1001
        private const val SESSION_EXPIRED_NOTIFICATION_ID = 1002
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
