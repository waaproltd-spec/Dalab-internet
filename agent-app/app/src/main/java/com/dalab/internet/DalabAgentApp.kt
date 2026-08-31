package com.dalab.internet

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.diagnostics.HeartbeatStats
import com.dalab.internet.notifications.AgentAlertsState
import com.dalab.internet.notifications.AgentFcmService
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.sms.SmsListenerState

/**
 * Referenced by AndroidManifest.xml (android:name=".DalabAgentApp") but never
 * actually created in the original delivery — the manifest would have failed
 * at launch with a ClassNotFoundException. Application-scoped singletons are
 * initialized here (each init() call is idempotent-guarded, so this is safe
 * even though MainActivity.onCreate() also calls them defensively).
 *
 * "DALAB Agent keeps stopping" was reported repeatedly with no stack trace to
 * go on — every previous fix came from manual code audit, not an actual
 * crash log. Two things were found auditing this class specifically:
 *
 * 1. All five init() calls below ran completely unguarded, at the very
 *    first moment the process starts — before MainActivity, before any
 *    BroadcastReceiver. [PendingActionQueue.init] in particular calls
 *    EncryptedSharedPreferences.create(), which touches the Android
 *    Keystore and is a well-documented source of real-device exceptions
 *    (a stale/invalidated key after an uninstall+reinstall, a corrupted
 *    encrypted prefs file, OEM keystore quirks) — if it threw here, the
 *    whole app would crash before a single screen ever rendered, with
 *    nothing recorded anywhere. Each call is now isolated in its own
 *    try/catch: a failure in one (e.g. the offline queue) no longer takes
 *    down the other four, and the failure itself is recorded instead of
 *    silently crashing.
 * 2. There was no process-wide safety net at all — any uncaught exception
 *    on any thread (a background coroutine, the SMS receiver, Compose
 *    rendering) always went straight to Android's default handler, which
 *    just kills the process ("keeps stopping") with the actual stack trace
 *    visible only via `adb logcat` on a connected computer — not something
 *    usable from a report like "DALAB Agent keeps stopping" with a photo of
 *    the OS dialog. A global uncaught-exception handler now writes the full
 *    stack trace to the Diagnostics screen (More > Diagnostics) — durably,
 *    via a synchronous commit() rather than the usual async apply(), so the
 *    write actually lands on disk before the process dies — and then still
 *    hands off to the previous default handler, so Android's normal crash
 *    behavior is unchanged; this only adds visibility.
 */
class DalabAgentApp : Application() {
    override fun onCreate() {
        super.onCreate()

        // Must be first and must not throw: everything else's failure handling
        // below depends on being able to log to it. getSharedPreferences() is
        // not a realistic throw site the way EncryptedSharedPreferences is.
        DiagnosticsLog.init(this)
        installCrashHandler()

        initSafely("session_init") { SessionManager.init(this) }
        initSafely("device_identity_init") { DeviceIdentity.init(this) }
        initSafely("sms_listener_init") { SmsListenerState.init(this) }
        initSafely("pending_queue_init") { PendingActionQueue.init(this) }
        initSafely("agent_alerts_init") { AgentAlertsState.init(this) }
        // Previously only initialized from MainActivity.kt, which never runs
        // for a process the OS started to host just the background service
        // (e.g. after a boot or a low-memory restart, with the agent never
        // manually reopening the app) -- every heartbeat tick's
        // HeartbeatStats.recordSuccess()/recordFailure() call then threw
        // UninitializedPropertyAccessException, uncaught, permanently
        // killing the heartbeat loop's coroutine while every other
        // background loop (SMS listener, connectivity callback, SIM
        // routing/queue-drain loops) kept running unaffected -- exactly
        // "shows Online, heartbeat stale for 5+ minutes and never recovers".
        initSafely("heartbeat_stats_init") { HeartbeatStats.init(this) }
        // Created here (Application.onCreate — guaranteed to run before any
        // component, including AgentFcmService) rather than in MainActivity,
        // so the channel already exists even if a support-request push
        // arrives before the agent has ever opened a screen this cold start.
        initSafely("support_notification_channel_init") { createSupportNotificationChannel() }
    }

    private fun createSupportNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                AgentFcmService.SUPPORT_CHANNEL_ID,
                "Customer support requests",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "A customer is waiting for a live agent"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 300, 150, 300)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun installCrashHandler() {
        val previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                DiagnosticsLog.recordFatal(thread.name, throwable)
            } catch (_: Throwable) {
                // Must never let logging itself block the crash from being
                // reported to the OS — fall through to the previous handler regardless.
            }
            previousHandler?.uncaughtException(thread, throwable)
        }
    }

    private inline fun initSafely(tag: String, block: () -> Unit) {
        try {
            block()
        } catch (e: Exception) {
            DiagnosticsLog.record(tag, "Startup init failed: ${e.stackTraceToString().take(2000)}")
        }
    }
}
