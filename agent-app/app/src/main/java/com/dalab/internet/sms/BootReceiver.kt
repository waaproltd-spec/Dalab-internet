package com.dalab.internet.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.service.AgentBackgroundService

/**
 * The manifest-declared SmsReceiver is always registered once the app is installed,
 * so this doesn't need to "start a service" for SMS itself — it just re-initializes
 * SmsListenerState from SharedPreferences so isListening reflects whatever the agent
 * had set before the reboot, and logs are ready to record again. It does need to
 * restart AgentBackgroundService though, since that's a real Service and doesn't
 * survive a reboot on its own — without this, a device that reboots silently stops
 * heartbeating/streaming until the agent manually reopens the app.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        try {
            DiagnosticsLog.init(context)
            SmsListenerState.init(context)
            SessionManager.init(context)
            DeviceIdentity.init(context)
            if (SessionManager.isLoggedIn() && DeviceIdentity.isSet()) {
                AgentBackgroundService.start(context)
            }
        } catch (e: Exception) {
            try {
                DiagnosticsLog.record("boot_receiver", "Failed on boot: ${e.stackTraceToString().take(2000)}")
            } catch (_: Exception) {
                // DiagnosticsLog.init() itself is what failed — nothing left to log to.
            }
        }
    }
}
