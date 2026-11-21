package com.dalab.internet.auth

import android.content.Context
import com.dalab.internet.diagnostics.DiagnosticsLog

/**
 * Keeps each system's data apart on a phone that signs in to a different
 * system than before (rare: a phone moved from one business to another).
 *
 * Everything that belongs to the old system is wiped BEFORE the new session
 * is saved: its device setup, Device Activation state, queued actions not yet
 * sent, alerts, SMS formats, reseller session. Nothing from one system is
 * ever sent to another. The app is then restarted ([needsRestart]) so no
 * in-memory copy of the old system's data (SIM routing, caches) survives.
 *
 * Kept on purpose: theme settings, Diagnostics, this install's id, and the
 * SMS ledger/scan position (so payment SMS the old system already handled
 * are not uploaded again to the new one).
 */
object SystemSwitch {
    private val SYSTEM_SCOPED_PREFS = listOf(
        "dalab_agent_session",
        "dalab_agent_device",
        "dalab_agent_activation",
        "dalab_agent_pending_queue",
        "dalab_agent_alerts",
        "dalab_agent_heartbeat_stats",
        "dalab_reseller_session",
        "dalab_sms_formats",
    )

    private lateinit var appContext: Context

    /** True after a sign-in to a different system than the last one; the UI restarts the app. */
    @Volatile
    var needsRestart: Boolean = false
        private set

    fun init(context: Context) {
        appContext = context.applicationContext
    }

    fun prepareFor(system: SignedInSystem) {
        val previous = SystemSession.systemKey()
        if (previous != null && previous != system.key) {
            for (name in SYSTEM_SCOPED_PREFS) {
                // Android keeps one SharedPreferences instance per name per
                // process, so this clears the very instance every store uses
                // (including the file behind an EncryptedSharedPreferences).
                appContext.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
            }
            needsRestart = true
            DiagnosticsLog.record("system_switch", "Signed in to a different system: this phone's data for the previous system was cleared.", isError = false)
        }
        SystemSession.save(system.key, system.name, system.apiUrl)
    }
}
