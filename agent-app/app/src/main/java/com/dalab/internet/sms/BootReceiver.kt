package com.dalab.internet.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The manifest-declared SmsReceiver is always registered once the app is installed,
 * so this doesn't need to "start a service" — it just re-initializes SmsListenerState
 * from SharedPreferences so isListening reflects whatever the agent had set before
 * the reboot, and logs are ready to record again.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        SmsListenerState.init(context)
    }
}
