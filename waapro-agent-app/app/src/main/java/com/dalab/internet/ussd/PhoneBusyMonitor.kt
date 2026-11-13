package com.dalab.internet.ussd

import android.content.Context
import android.telephony.TelephonyManager
import kotlinx.coroutines.delay

/**
 * Is the phone's owner using it for USSD or a call right now? The Agent App
 * must never start a USSD session over theirs: two USSD sessions on one
 * phone abort each other or mix up replies, which could break a manual
 * money transfer as well as the app's own payment.
 *
 * Signals (all on the phone; the server can't see any of this):
 *  - a USSD window the Agent App did NOT open (the owner is sending money,
 *    checking a balance...), seen by the app's accessibility service;
 *  - the phone dialer in front (the owner is typing a code like *712#);
 *  - an active phone call (TelephonyManager call state).
 * When all clear, the app waits [QUIET_MS] more so the carrier has fully
 * closed the owner's session, then the next queued request dials. A dialer
 * or USSD window left open counts for at most [MAX_DIALER_MS]/[MAX_USSD_MS]
 * so a forgotten screen can't hold payments forever; a call always counts.
 * Without the accessibility service on, only calls can be seen.
 */
object PhoneBusyMonitor {
    const val QUIET_MS = 10_000L
    const val MAX_DIALER_MS = 2 * 60_000L
    const val MAX_USSD_MS = 3 * 60_000L

    enum class WindowKind { USSD_DIALOG, DIALER, NEUTRAL, OTHER }

    @Volatile private var manualUssdSince: Long? = null
    @Volatile private var dialerSince: Long? = null
    @Volatile private var lastBusyEndedAt: Long = 0L
    private var appContext: Context? = null

    fun init(context: Context) {
        appContext = context.applicationContext
        UssdSimLock.phoneFreeGate = { onWaiting -> awaitFree(onWaiting) }
    }

    /** Which kind of window just came to the front. Pure; unit-tested. */
    fun classify(packageName: String?, className: String?, ownPackage: String): WindowKind {
        val pkg = packageName.orEmpty().lowercase()
        val cls = className.orEmpty().lowercase()
        if (pkg.isEmpty()) return WindowKind.NEUTRAL
        // Status bar / notification shade / keyboard: not a change of app.
        if (pkg == "com.android.systemui" || "inputmethod" in pkg || "keyboard" in pkg) return WindowKind.NEUTRAL
        if (pkg == ownPackage.lowercase()) return WindowKind.OTHER
        // The carrier's USSD reply window (stock: com.android.phone, OEMs their own).
        if ("ussd" in cls || "mmi" in cls || pkg == "com.android.phone" || pkg == "com.android.stk" || "telephonyui" in pkg) {
            return WindowKind.USSD_DIALOG
        }
        if ("dialer" in pkg || "incallui" in pkg || "incall" in cls || "dialtacts" in cls || "dialer" in cls) return WindowKind.DIALER
        return WindowKind.OTHER
    }

    /**
     * Fed by the accessibility services on every window change. Ignored
     * while the Agent App itself is dialing (that USSD window is its own).
     */
    fun onWindowChanged(packageName: String?, className: String?, ownPackage: String, now: Long = System.currentTimeMillis()) {
        val s = UssdSimLock.status.value
        if (s.running != null && s.phoneBusy == null) return // our own session is on screen
        when (classify(packageName, className, ownPackage)) {
            WindowKind.USSD_DIALOG -> if (manualUssdSince == null) manualUssdSince = now
            WindowKind.DIALER -> if (dialerSince == null) dialerSince = now
            WindowKind.NEUTRAL -> Unit
            WindowKind.OTHER -> if (manualUssdSince != null || dialerSince != null) {
                manualUssdSince = null
                dialerSince = null
                lastBusyEndedAt = now
            }
        }
    }

    /** Why the phone is busy, or null when the app may dial. Pure; unit-tested. */
    fun busyReason(manualUssdSince: Long?, dialerSince: Long?, inCall: Boolean, lastBusyEndedAt: Long, now: Long): String? = when {
        inCall -> "a phone call"
        manualUssdSince != null && now - manualUssdSince < MAX_USSD_MS -> "a USSD session"
        dialerSince != null && now - dialerSince < MAX_DIALER_MS -> "the phone dialer"
        now - lastBusyEndedAt < QUIET_MS -> "the phone was just used"
        else -> null
    }

    private fun inCall(): Boolean = try {
        val tm = appContext?.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        @Suppress("DEPRECATION")
        tm != null && tm.callState != TelephonyManager.CALL_STATE_IDLE
    } catch (_: Exception) {
        false // no permission to read call state: can't tell, don't block
    }

    private var callWasActive = false

    /** Suspends until the phone is free, reporting the reason while it waits. */
    suspend fun awaitFree(onWaiting: suspend (String?) -> Unit) {
        while (true) {
            val now = System.currentTimeMillis()
            val call = inCall()
            if (callWasActive && !call) lastBusyEndedAt = now // call just ended: quiet period
            callWasActive = call
            val reason = busyReason(manualUssdSince, dialerSince, call, lastBusyEndedAt, now)
            onWaiting(reason)
            if (reason == null) return
            delay(1_000L)
        }
    }

    /** The current reason from window events alone (tests). */
    internal fun reasonNow(now: Long, inCall: Boolean = false): String? =
        busyReason(manualUssdSince, dialerSince, inCall, lastBusyEndedAt, now)

    internal fun resetForTest() {
        manualUssdSince = null
        dialerSince = null
        lastBusyEndedAt = 0L
        callWasActive = false
    }
}
