package com.dalab.internet.sms

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import com.dalab.internet.data.SmsLogEntry
import com.dalab.internet.diagnostics.DiagnosticsLog

/**
 * Whether this phone is taking in payment SMS. It is exactly "the SMS
 * permissions are granted" -- re-checked on every incoming SMS and every
 * recovery pass.
 *
 * This used to be a separate saved flag ("is_listening") that only the
 * in-app permission prompt ever set to true. A phone that already had the
 * permission (granted from Android Settings, kept across a reinstall, or
 * granted before the flag existed) skipped that prompt, so the flag stayed
 * false forever and SmsReceiver silently dropped every payment SMS
 * ("sms_receiver_ignored") while nothing in the app could turn it back on.
 * Nothing ever set it to false on purpose, so there is no "off" state to keep.
 */
object SmsListenerState {
    private val _isListening = MutableStateFlow(false)
    val isListening: StateFlow<Boolean> = _isListening.asStateFlow()

    private val _recentLogs = MutableStateFlow<List<SmsLogEntry>>(emptyList())
    val recentLogs: StateFlow<List<SmsLogEntry>> = _recentLogs.asStateFlow()

    @Volatile private var appContext: Context? = null
    @Volatile private var checkedOnce = false

    fun init(context: Context) {
        appContext = context.applicationContext
        refresh(context)
    }

    fun hasSmsPermissions(context: Context): Boolean =
        SMS_PERMISSIONS.all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }

    /** Re-reads the permission state, logs any change, and returns whether
     * SMS can be received. */
    @Synchronized
    fun refresh(context: Context): Boolean {
        val granted = hasSmsPermissions(context)
        val previous = _isListening.value
        _isListening.value = granted
        if (!checkedOnce || previous != granted) {
            checkedOnce = true
            if (granted) {
                DiagnosticsLog.record("sms_listener_started", "Receiving payment SMS (SMS permission granted).", isError = false)
            } else {
                DiagnosticsLog.record(
                    "sms_permission_missing",
                    "SMS permission is not granted — payment SMS can't be received. Open the app and allow SMS, or grant it in Android Settings > Apps > DALAB Agent > Permissions.",
                )
                if (previous) DiagnosticsLog.record("sms_listener_stopped", "Stopped receiving payment SMS (SMS permission was removed).")
            }
        }
        return granted
    }

    /** Kept for the permission prompt's callback: the permission result is
     * the real source of truth, so this just re-checks it. */
    fun setListening(@Suppress("UNUSED_PARAMETER") enabled: Boolean) {
        appContext?.let { refresh(it) }
    }

    fun recordLog(entry: SmsLogEntry) {
        _recentLogs.value = (listOf(entry) + _recentLogs.value).take(50)
    }

    val SMS_PERMISSIONS = arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS)
}
