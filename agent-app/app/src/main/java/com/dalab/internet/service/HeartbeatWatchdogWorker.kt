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
import java.util.concurrent.TimeUnit

/**
 * Backstop for AgentBackgroundService: WorkManager's own scheduler can run
 * even after the OS has killed this app's process outright (Doze, an OEM
 * battery manager, low memory) without a full device reboot — a gap
 * START_STICKY alone doesn't cover, since START_STICKY only helps once the
 * OS decides to recreate the service "when resources permit," which is
 * unbounded and never happens at all if the app was force-stopped. Each
 * tick is a cheap no-op if the service is already alive.
 */
class HeartbeatWatchdogWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        return try {
            if (DeviceIdentity.isSet() && SessionManager.isLoggedIn() && !AgentBackgroundService.isRunning) {
                DiagnosticsLog.record("watchdog_worker", "Foreground service not running — restarting.")
                AgentBackgroundService.start(applicationContext)
            }
            Result.success()
        } catch (e: Exception) {
            DiagnosticsLog.record("watchdog_worker", "Tick failed: ${e.stackTraceToString().take(2000)}")
            Result.success()
        }
    }

    companion object {
        private const val WORK_NAME = "agent_background_watchdog"

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
