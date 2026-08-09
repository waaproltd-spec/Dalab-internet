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

    @Volatile
    private var lastAutoConfirmedDialogText: String? = null

    private var events = Channel<UssdDialogEvent>(capacity = Channel.CONFLATED)

    private val mainHandler = Handler(Looper.getMainLooper())
    private var pinPollRunnable: Runnable? = null
    private const val PIN_POLL_INTERVAL_MS = 500L

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
        lastAutoConfirmedDialogText = null
        stopPinPolling()
        armed = true
    }

    fun disarm() {
        armed = false
        pendingPinToInject = null
        lastAutoConfirmedDialogText = null
        stopPinPolling()
    }

    /** Tells the service to fill+submit this PIN into the next input-bearing
     * dialog it sees, then actively re-checks the currently foregrounded
     * window at a short interval until it's consumed (submitted) or the
     * attempt ends. A single immediate check isn't enough: the reply
     * dialog's input field can render a beat after the window itself
     * appears, and some OEM dialogs never fire a second accessibility event
     * once drawn — leaving a purely event-driven scan no way to try again
     * before ExchangeUssdOrchestrator's step-2 timeout gives up (confirmed
     * live on order DEX933880917: STEP2_FAILED, PIN never actually typed).
     * Polling only changes how often scanAndAct() gets called — what it
     * does with what it finds (inject once, else restore for next look) is
     * unchanged. */
    fun armPinInjection(pin: String) {
        pendingPinToInject = pin
        startPinPolling()
    }

    private fun startPinPolling() {
        stopPinPolling()
        val runnable = object : Runnable {
            override fun run() {
                if (!armed || pendingPinToInject == null) return // submitted, or attempt finished/cancelled — stop
                ExchangeUssdAccessibilityService.instance?.scanAndAct()
                if (armed && pendingPinToInject != null) {
                    mainHandler.postDelayed(this, PIN_POLL_INTERVAL_MS)
                }
            }
        }
        pinPollRunnable = runnable
        mainHandler.post(runnable)
    }

    private fun stopPinPolling() {
        pinPollRunnable?.let(mainHandler::removeCallbacks)
        pinPollRunnable = null
    }

    internal fun consumePendingPinToInject(): String? {
        val pin = pendingPinToInject
        pendingPinToInject = null
        return pin
    }

    /** Puts the PIN back if the window scanAndAct just looked at wasn't the
     * right one — e.g. it had no input field yet — so a later poll/window
     * still gets it. */
    internal fun restorePendingPinToInject(pin: String) {
        pendingPinToInject = pin
    }

    /** True the first time this exact dialog text is seen during the
     * current attempt — and remembers it, so a repeat scan of the same
     * still-on-screen confirmation dialog (multiple accessibility events
     * can fire before the tap actually dismisses it) never taps its button
     * twice. A different dialog text (the next step in a multi-screen
     * confirm flow) is allowed through again. */
    internal fun shouldAutoConfirm(dialogText: String): Boolean {
        if (dialogText == lastAutoConfirmedDialogText) return false
        lastAutoConfirmedDialogText = dialogText
        return true
    }

    internal fun emit(event: UssdDialogEvent) {
        events.trySend(event)
    }

    /** Discards any event already buffered in the conflated channel before a
     * fresh wait starts, so awaitNextEvent only ever returns something that
     * happens *after* this call — not a stray DialogSeen left over from a
     * still-on-screen dialog re-firing an accessibility event during the
     * previous step's network round-trip (confirmed live: STEP2_FAILED
     * firing ~5s after dialing, an order of magnitude under the 15s budget,
     * on orders DEX176626979 and DEX565544915). */
    internal fun drainStaleEvents() {
        while (events.tryReceive().isSuccess) {
            // discard
        }
    }

    suspend fun awaitNextEvent(timeoutMs: Long): UssdDialogEvent? = withTimeoutOrNull(timeoutMs) {
        events.receive()
    }
}
