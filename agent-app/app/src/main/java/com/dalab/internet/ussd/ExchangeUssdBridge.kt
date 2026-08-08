package com.dalab.internet.ussd

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeoutOrNull

/**
 * In-process bridge between [ExchangeUssdAccessibilityService] (which reads
 * and drives the native USSD reply dialog) and [ExchangeUssdOrchestrator]
 * (which decides what each dialog means and when to inject the PIN). Kept
 * deliberately tiny and stateless-between-attempts: the PIN is held here
 * only for the seconds it takes the service to fill+submit it, then cleared
 * — never logged, never persisted, never exposed outside this process.
 */
object ExchangeUssdBridge {

    @Volatile
    var serviceConnected: Boolean = false
        internal set

    @Volatile
    var armed: Boolean = false
        private set

    @Volatile
    private var pendingPinToInject: String? = null

    private var events = Channel<UssdDialogEvent>(capacity = Channel.CONFLATED)

    fun isAccessibilityServiceEnabled(context: Context): Boolean {
        val enabled = Settings.Secure.getString(
            context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val expected = "${context.packageName}/${ExchangeUssdAccessibilityService::class.java.name}"
        return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
    }

    /** Starts a fresh watch session — a new channel so a stale event from a
     * previous, already-finished attempt can never be misread as belonging
     * to this one. */
    fun arm() {
        events = Channel(capacity = Channel.CONFLATED)
        pendingPinToInject = null
        armed = true
    }

    fun disarm() {
        armed = false
        pendingPinToInject = null
    }

    /** Tells the service to fill+submit this PIN into the next input-bearing
     * dialog it sees, and asks it to re-check the currently foregrounded
     * window immediately (in case the target dialog is already on screen and
     * won't otherwise fire a fresh accessibility event). */
    fun armPinInjection(pin: String) {
        pendingPinToInject = pin
        Handler(Looper.getMainLooper()).post {
            ExchangeUssdAccessibilityService.instance?.scanAndAct()
        }
    }

    internal fun consumePendingPinToInject(): String? {
        val pin = pendingPinToInject
        pendingPinToInject = null
        return pin
    }

    /** Puts the PIN back if the window scanAndAct just looked at wasn't the
     * right one — e.g. it had no input field yet — so a later window still
     * gets it. */
    internal fun restorePendingPinToInject(pin: String) {
        pendingPinToInject = pin
    }

    internal fun emit(event: UssdDialogEvent) {
        events.trySend(event)
    }

    suspend fun awaitNextEvent(timeoutMs: Long): UssdDialogEvent? = withTimeoutOrNull(timeoutMs) {
        events.receive()
    }
}
