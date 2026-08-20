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
import com.dalab.internet.diagnostics.HeartbeatStats
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.DiagnosticsEntryDto
import com.dalab.internet.network.HeartbeatFailure
import com.dalab.internet.network.HeartbeatFailureClassifier
import com.dalab.internet.network.HeartbeatRequest
import com.dalab.internet.network.RealtimeClient
import com.dalab.internet.queue.QueueDrainer
import com.dalab.internet.queue.RetryClassifier
import com.dalab.internet.sms.SmsSenderIdRepository
import com.dalab.internet.ussd.ExchangeSelfHealSweeper
import com.dalab.internet.ussd.ResellerWithdrawalSelfHealSweeper
import com.dalab.internet.ussd.SelfHealSweeper
import com.dalab.internet.ussd.SimRoutingRepository
import com.dalab.internet.ussd.ResellerWithdrawalSimRoutingRepository
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
                try {
                    realtimeClient?.state?.collect { AgentEventBus.setConnectionState(it) }
                } catch (e: Exception) {
                    // Unguarded before: an exception here would silently kill
                    // this coroutine forever (SupervisorJob only stops it from
                    // cancelling siblings) — the connection-state indicator
                    // would just stop updating with no trace anywhere.
                    DiagnosticsLog.record("background_service_realtime_state", "Connection-state relay died: ${e.stackTraceToString().take(2000)}")
                }
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
        newScope.launch { ResellerWithdrawalSimRoutingRepository.refresh() }
        newScope.launch { SmsSenderIdRepository.refresh() }
        newScope.launch {
            try {
                QueueDrainer.drainAll(applicationContext)
            } catch (e: Exception) {
                DiagnosticsLog.record("background_service_queue_drain", "Initial drain failed: ${e.stackTraceToString().take(2000)}")
            }
        }
        newScope.launch {
            try {
                SelfHealSweeper.sweep(applicationContext)
            } catch (e: Exception) {
                DiagnosticsLog.record("self_heal_sweep", "Initial sweep failed: ${e.stackTraceToString().take(2000)}")
            }
        }
        newScope.launch {
            try {
                ExchangeSelfHealSweeper.sweep(applicationContext)
            } catch (e: Exception) {
                DiagnosticsLog.record("exchange_self_heal_sweep", "Initial sweep failed: ${e.stackTraceToString().take(2000)}")
            }
        }
        newScope.launch {
            try {
                ResellerWithdrawalSelfHealSweeper.sweep(applicationContext)
            } catch (e: Exception) {
                DiagnosticsLog.record("reseller_withdrawal_self_heal_sweep", "Initial sweep failed: ${e.stackTraceToString().take(2000)}")
            }
        }
        newScope.launch {
            // Near-instant recovery the moment a Super Admin fixes whatever
            // blocked generation (a missing PIN/template) — the backend's own
            // self-heal broadcasts order.updated over this same SSE stream
            // OrdersListScreen already listens to, so this is a second,
            // independent consumer of an event that already exists. Also
            // fires on exchange_order.updated and reseller_withdrawal.updated
            // (same generic stream/event bus), which is what makes Money
            // Exchange and Reseller Withdraw payouts start the moment a
            // payment is verified/a withdrawal is created — see
            // ExchangeSelfHealSweeper/ResellerWithdrawalSelfHealSweeper.
            AgentEventBus.orderEvents.collect {
                try {
                    SelfHealSweeper.sweep(applicationContext)
                } catch (e: Exception) {
                    DiagnosticsLog.record("self_heal_sweep", "Event-triggered sweep failed: ${e.stackTraceToString().take(2000)}")
                }
                try {
                    ExchangeSelfHealSweeper.sweep(applicationContext)
                } catch (e: Exception) {
                    DiagnosticsLog.record("exchange_self_heal_sweep", "Event-triggered sweep failed: ${e.stackTraceToString().take(2000)}")
                }
                try {
                    ResellerWithdrawalSelfHealSweeper.sweep(applicationContext)
                } catch (e: Exception) {
                    DiagnosticsLog.record("reseller_withdrawal_self_heal_sweep", "Event-triggered sweep failed: ${e.stackTraceToString().take(2000)}")
                }
            }
        }

        newScope.launch { heartbeatLoop() }
        newScope.launch { simRoutingRefreshLoop() }
        newScope.launch { queueDrainLoop() }
        newScope.launch { selfHealSweepLoop() }
        newScope.launch { exchangeSelfHealSweepLoop() }
        newScope.launch { resellerWithdrawalSelfHealSweepLoop() }
        newScope.launch {
            // There's no login screen to send the agent to anymore, so a dead
            // session first tries to silently re-authenticate itself the same
            // way app startup does (this device's assigned agent) — no
            // interaction needed for the common case (e.g. an admin-triggered
            // token revocation). Only if that also fails (no agent currently
            // assigned to this device) does this surface a notification,
            // since every SMS upload/verify/dial call would otherwise silently
            // 401 forever with nothing telling the agent payments stopped.
            //
            // This collector must survive for the app's entire lifetime — an
            // uncaught exception previously killed it silently forever, after
            // which a real future session expiry would stop all SMS
            // processing with zero notification. The while(isActive) restart
            // loop means one bad tick doesn't end monitoring permanently.
            while (isActive) {
                try {
                    AgentEventBus.sessionExpired.collect {
                        val deviceId = DeviceIdentity.deviceId()
                        val recovered = deviceId != null && AuthRepository.loginWithDevice(deviceId) is LoginResult.Success
                        if (!recovered) notifySessionExpired()
                    }
                } catch (e: Exception) {
                    DiagnosticsLog.record("background_service_session_expired", "Collector died, restarting: ${e.stackTraceToString().take(2000)}")
                }
            }
        }
        try {
            registerConnectivityCallback(newScope)
        } catch (e: Exception) {
            DiagnosticsLog.record("background_service_connectivity", "Failed to register network callback: ${e.stackTraceToString().take(2000)}")
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    // Several OEM ROMs (MIUI, ColorOS, FuntouchOS, etc.) kill every background
    // process of an app the instant its task is swiped from Recents,
    // regardless of this service's lack of android:stopWithTask and its
    // START_STICKY return value. This schedules a near-immediate restart via
    // AlarmManager (no special "exact alarm" permission needed) as a fast
    // path — the WorkManager watchdog below only checks every ~15 minutes.
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        try {
            val restartIntent = Intent(applicationContext, AgentBackgroundService::class.java)
            val flags = android.app.PendingIntent.FLAG_ONE_SHOT or android.app.PendingIntent.FLAG_IMMUTABLE
            val pendingIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                android.app.PendingIntent.getForegroundService(applicationContext, 0, restartIntent, flags)
            } else {
                android.app.PendingIntent.getService(applicationContext, 0, restartIntent, flags)
            }
            val alarmManager = getSystemService(Context.ALARM_SERVICE) as? android.app.AlarmManager
            alarmManager?.setAndAllowWhileIdle(
                android.app.AlarmManager.ELAPSED_REALTIME_WAKEUP,
                android.os.SystemClock.elapsedRealtime() + 1_000L,
                pendingIntent,
            )
        } catch (e: Exception) {
            DiagnosticsLog.record("background_service_task_removed", "Restart scheduling failed: ${e.stackTraceToString().take(2000)}")
        }
    }

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
    //
    // Also the moment to reconnect the SSE stream and sweep for missed work:
    // realtimeClient may still be sitting mid-backoff (up to 30s) from
    // whatever caused the drop, and reconnecting only re-arms it for FUTURE
    // events anyway — there's no replay of anything broadcast while this
    // device was offline. A device that comes back online without this would
    // otherwise wait out its own SSE backoff and then up to 3 more minutes
    // for the periodic self-heal sweep before a payment verified while it
    // was offline actually gets dialed.
    private fun registerConnectivityCallback(scope: CoroutineScope) {
        val connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scope.launch { QueueDrainer.drainAll(applicationContext) }
                scope.launch { realtimeClient?.connect() }
                scope.launch {
                    try {
                        SelfHealSweeper.sweep(applicationContext)
                    } catch (e: Exception) {
                        DiagnosticsLog.record("self_heal_sweep", "Network-available sweep failed: ${e.stackTraceToString().take(2000)}")
                    }
                }
                scope.launch {
                    try {
                        ExchangeSelfHealSweeper.sweep(applicationContext)
                    } catch (e: Exception) {
                        DiagnosticsLog.record("exchange_self_heal_sweep", "Network-available sweep failed: ${e.stackTraceToString().take(2000)}")
                    }
                }
                scope.launch {
                    try {
                        ResellerWithdrawalSelfHealSweeper.sweep(applicationContext)
                    } catch (e: Exception) {
                        DiagnosticsLog.record("reseller_withdrawal_self_heal_sweep", "Network-available sweep failed: ${e.stackTraceToString().take(2000)}")
                    }
                }
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
                // Snapshot before the call, not after — an entry recorded by
                // this very tick's own failure path below must wait for the
                // *next* tick to go out, same as any other pending entry.
                val pendingDiagnostics = DiagnosticsLog.unsyncedEntries()
                sendHeartbeatWithRetry(deviceId, pendingDiagnostics)
            }
            delay(HEARTBEAT_INTERVAL_MS)
        }
    }

    /**
     * Up to 4 attempts within this single tick (2s/4s/8s backoff between
     * them) before giving up until the next regular 60s tick — this is what
     * lets a heartbeat recover from a transient blip (e.g. the backend
     * mid-cold-start on a free-tier host) within the same cycle instead of
     * waiting a full extra minute. Every attempt's failure is classified via
     * HeartbeatFailureClassifier (DNS/TLS/timeout/connection/HTTP) so the
     * Reliability Dashboard's "Last error" line is specific, not a bare
     * exception message — the previous behavior gave no way to tell "the
     * backend is cold-starting" apart from "this device has no signal."
     * Runs on this same coroutine only -- never blocks or shares state with
     * SMS processing (SmsReceiver's own goAsync-bound scope), payment
     * verification, or order dispatch, all of which run on their own
     * independent triggers/loops and are unaffected by heartbeat health.
     */
    private suspend fun sendHeartbeatWithRetry(deviceId: String, pendingDiagnostics: List<DiagnosticsLog.Entry>) {
        var lastFailure = HeartbeatFailure("unknown", "Not attempted")
        for (attempt in 1..HEARTBEAT_MAX_ATTEMPTS) {
            try {
                RetryClassifier.requireSuccessful(ApiClient.service.sendHeartbeat(deviceId, buildHeartbeat(pendingDiagnostics)))
                HeartbeatStats.recordSuccess()
                if (pendingDiagnostics.isNotEmpty()) {
                    DiagnosticsLog.markSyncedUpTo(pendingDiagnostics.last().timestamp)
                }
                return
            } catch (e: Exception) {
                lastFailure = HeartbeatFailureClassifier.classify(e)
                // Tagged by category (not a generic "heartbeat_loop" label) so
                // these entries - once uploaded via recentDiagnostics - are
                // groupable server-side too, and so a per-category breakdown
                // survives even past DiagnosticsLog's own 200-entry cap.
                DiagnosticsLog.record(
                    "heartbeat_failed_${lastFailure.category}",
                    "Heartbeat attempt $attempt/$HEARTBEAT_MAX_ATTEMPTS failed: ${lastFailure.message}",
                )
                if (attempt < HEARTBEAT_MAX_ATTEMPTS) delay(HEARTBEAT_RETRY_BASE_DELAY_MS * (1L shl (attempt - 1)))
            }
        }
        // Best-effort — the next regular tick tries again automatically (this
        // loop never stops on failure); a dropped heartbeat just shows as a
        // stale "last seen" on the dashboard in the meantime.
        HeartbeatStats.recordFailure(lastFailure.category, lastFailure.message)
    }

    // Runs on its own timer rather than piggybacking on the heartbeat tick
    // (a separate concern — device telemetry vs. provider routing — even
    // though they currently share the same cadence), so a dashboard
    // routing change reaches the device within about a minute without
    // requiring the agent to restart the app.
    private suspend fun simRoutingRefreshLoop() {
        val currentScope = scope ?: return
        while (currentScope.isActive) {
            delay(SIM_ROUTING_REFRESH_INTERVAL_MS)
            try {
                if (DeviceIdentity.isSet() && SessionManager.isLoggedIn()) {
                    SimRoutingRepository.refresh()
                    ResellerWithdrawalSimRoutingRepository.refresh()
                    SmsSenderIdRepository.refresh()
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

    // Backstop for the event-triggered sweep above (e.g. this device missed
    // the SSE event, or was offline when it fired) — a light read-only GET
    // plus, at most, a handful of dials, so a few minutes' cadence is a safe
    // fallback without hammering the backend.
    private suspend fun selfHealSweepLoop() {
        val currentScope = scope ?: return
        while (currentScope.isActive) {
            delay(SELF_HEAL_SWEEP_INTERVAL_MS)
            try {
                SelfHealSweeper.sweep(applicationContext)
            } catch (e: Exception) {
                DiagnosticsLog.record("self_heal_sweep_loop", "Tick failed: ${e.stackTraceToString().take(2000)}")
            }
        }
    }

    // Same backstop role as selfHealSweepLoop() above, for Money Exchange's
    // own queue — a separate loop (not piggybacked onto the Store one)
    // because the two pipelines are independent business lines with their
    // own queues, orchestrators, and failure modes.
    private suspend fun exchangeSelfHealSweepLoop() {
        val currentScope = scope ?: return
        while (currentScope.isActive) {
            delay(SELF_HEAL_SWEEP_INTERVAL_MS)
            try {
                ExchangeSelfHealSweeper.sweep(applicationContext)
            } catch (e: Exception) {
                DiagnosticsLog.record("exchange_self_heal_sweep_loop", "Tick failed: ${e.stackTraceToString().take(2000)}")
            }
        }
    }

    // Same backstop role as selfHealSweepLoop()/exchangeSelfHealSweepLoop()
    // above, for Reseller Withdraw's own queue — a separate loop because
    // it's a third, independent business line with its own queue,
    // orchestrator, and failure modes.
    private suspend fun resellerWithdrawalSelfHealSweepLoop() {
        val currentScope = scope ?: return
        while (currentScope.isActive) {
            delay(SELF_HEAL_SWEEP_INTERVAL_MS)
            try {
                ResellerWithdrawalSelfHealSweeper.sweep(applicationContext)
            } catch (e: Exception) {
                DiagnosticsLog.record("reseller_withdrawal_self_heal_sweep_loop", "Tick failed: ${e.stackTraceToString().take(2000)}")
            }
        }
    }

    private fun buildHeartbeat(pendingDiagnostics: List<DiagnosticsLog.Entry>): HeartbeatRequest {
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
            recentDiagnostics = pendingDiagnostics.takeIf { it.isNotEmpty() }?.map {
                DiagnosticsEntryDto(tag = it.tag, message = it.message, isError = it.isError, occurredAt = it.timestamp)
            },
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
        private const val HEARTBEAT_MAX_ATTEMPTS = 4
        private const val HEARTBEAT_RETRY_BASE_DELAY_MS = 2_000L
        // Matches HEARTBEAT_INTERVAL_MS's cadence — a Super Admin routing
        // change (which device/SIM slot handles a provider) now reaches a
        // device within about a minute instead of five.
        private const val SIM_ROUTING_REFRESH_INTERVAL_MS = HEARTBEAT_INTERVAL_MS
        // Tightened from 2min/3min — these only run after something already
        // went wrong (a dropped connection, the process dying mid-dial), so
        // a shorter interval speeds up recovery without touching the normal
        // synchronous upload->match->verify->dial path, which already has
        // zero artificial delay in it.
        private const val QUEUE_DRAIN_INTERVAL_MS = 45_000L
        private const val SELF_HEAL_SWEEP_INTERVAL_MS = 60_000L

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
            // Single choke point: every call site that starts this service
            // (MainActivity on cold start, AutoLoginScreen on success,
            // BootReceiver after a reboot) also gets the watchdog for free.
            HeartbeatWatchdogWorker.schedule(context)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AgentBackgroundService::class.java))
        }
    }
}
