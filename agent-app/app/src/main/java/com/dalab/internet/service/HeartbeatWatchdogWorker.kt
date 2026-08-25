package com.dalab.internet.service

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.diagnostics.HeartbeatStats
import java.util.concurrent.TimeUnit

/**
 * Backstop for AgentBackgroundService: WorkManager's own scheduler can run
 * even after the OS has killed this app's process outright (Doze, an OEM
 * battery manager, low memory) without a full device reboot — a gap
 * START_STICKY alone doesn't cover, since START_STICKY only helps once the
 * OS decides to recreate the service "when resources permit," which is
 * unbounded and never happens at all if the app was force-stopped. Each
 * tick is a cheap no-op if the service is already alive and heartbeating.
 *
 * Originally only checked [AgentBackgroundService.isRunning] — a real gap,
 * since a service instance can report running while one of its internal
 * coroutines (heartbeatLoop) has silently died on its own (see
 * DalabAgentApp's HeartbeatStats init fix and AgentBackgroundService's own
 * per-tick try/catch, added for the exact same failure). That looked
 * identical to a healthy device from this worker's old perspective: service
 * alive, so nothing to do, while heartbeats had actually stopped forever.
 * Now also checks heartbeat freshness via [shouldRestartAgentService] and,
 * if stale, stops and restarts the service (see
 * [AgentBackgroundService.restart]) rather than merely calling
 * [AgentBackgroundService.start] on the already-running instance, which
 * would only re-deliver onStartCommand() and do nothing -- a service
 * already reporting alive needs a genuinely fresh instance/onCreate() to
 * get a new heartbeatLoop coroutine, not another onStartCommand() delivery.
 */
class HeartbeatWatchdogWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        return try {
            if (DeviceIdentity.isSet() && SessionManager.isLoggedIn()) {
                val running = AgentBackgroundService.isRunning
                if (shouldRestartAgentService(running, HeartbeatStats.lastSuccessAt(), System.currentTimeMillis(), HEARTBEAT_STALE_THRESHOLD_MS)) {
                    if (running) {
                        DiagnosticsLog.record(
                            "watchdog_worker",
                            "Service reports running but heartbeat is stale (over ${HEARTBEAT_STALE_THRESHOLD_MS / 60_000}m) — restarting to recover a dead heartbeat loop.",
                        )
                        AgentBackgroundService.restart(applicationContext)
                    } else {
                        DiagnosticsLog.record("watchdog_worker", "Foreground service not running — restarting.")
                        AgentBackgroundService.start(applicationContext)
                    }
                }
            }
            Result.success()
        } catch (e: Exception) {
            DiagnosticsLog.record("watchdog_worker", "Tick failed: ${e.stackTraceToString().take(2000)}")
            Result.success()
        }
    }

    companion object {
        private const val WORK_NAME = "agent_background_watchdog"
        // Matches the Super Admin dashboard's own "No heartbeat in over 5
        // minutes" staleness definition -- one consistent threshold across
        // the system rather than two independently-tuned numbers that could
        // drift apart. Comfortably above HEARTBEAT_INTERVAL_MS (60s) plus
        // its own worst-case in-tick retry window, so a single slow/failed
        // tick alone never triggers a restart.
        const val HEARTBEAT_STALE_THRESHOLD_MS = 5 * 60_000L

        /** KEEP means re-scheduling on every AgentBackgroundService.start() call
         * (app open, re-login, reboot) is a safe no-op rather than resetting the
         * periodic timer each time. */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<HeartbeatWatchdogWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request,
            )
        }
    }
}

/** Pulled out as a pure function (no Context/WorkManager/Android dependency)
 * so this decision can be unit-tested directly — see
 * HeartbeatWatchdogWorkerTest. Not running at all is always worth
 * restarting regardless of heartbeat history (there's no service instance
 * to have recorded one recently, or its last recording predates this
 * process entirely). A service reporting running is only restarted once its
 * last successful heartbeat is *strictly older* than [staleThresholdMs] --
 * exactly at the threshold is still healthy, matching how the interval is
 * documented (comfortably above one tick's worst case, not a hard SLA) --
 * or if it has never recorded one at all, which after this worker's own
 * 15-minute cadence (many multiples of the 60s heartbeat interval) means
 * something is already wrong, not simply "too early to tell." */
internal fun shouldRestartAgentService(
    isServiceRunning: Boolean,
    lastHeartbeatSuccessAt: Long?,
    now: Long,
    staleThresholdMs: Long,
): Boolean {
    if (!isServiceRunning) return true
    if (lastHeartbeatSuccessAt == null) return true
    return now - lastHeartbeatSuccessAt > staleThresholdMs
}
