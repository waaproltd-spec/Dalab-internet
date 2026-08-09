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

    /** True once [UssdDialogEvent.PinSubmitted] has been emitted for the
     * current attempt — the signal that distinguishes a pre-PIN confirm
     * screen (Step 1) from the separate post-PIN confirm screen (Step 3),
     * without duplicating that state in the accessibility service. */
    @Volatile
    private var pinSubmitted: Boolean = false

    /** Separate dedup trackers for the two stages a confirm screen can
     * belong to — kept independent so an identically-worded Step 1 and
     * Step 3 confirm screen can never collide and cause Step 3 to be
     * wrongly treated as "already tapped" and silently skipped. */
    @Volatile
    private var lastPreConfirmText: String? = null

    @Volatile
    private var lastPostConfirmText: String? = null

    /** The package name of the window this attempt has confirmed is the
     * real carrier dialog — set the first time a scan sees any dialog text
     * at all (armed only goes true right as the USSD dial is placed, so the
     * first window to show any text is overwhelmingly likely to be the
     * actual dialer). Every later scan in this attempt must come from this
     * same window; a mismatch means the foreground drifted to an unrelated
     * app (e.g. Chrome) and must never be treated as carrier output or have
     * a PIN injected into it. */
    @Volatile
    private var lockedPackageName: String? = null

    @Volatile
    private var lastLoggedMismatchPackage: String? = null

    /** True once a post-PIN (Step 3) confirmation screen has already been
     * auto-tapped this attempt. Caps that auto-tap to at most once: the
     * carrier's own final receipt reuses the same dialog template (still
     * has an EditText, may still have an OK/Send-looking button), so
     * without this cap a genuinely final screen could be mistaken for
     * another Step 3 confirm and tapped instead of being accepted as the
     * real result. */
    @Volatile
    private var postPinConfirmationTapped: Boolean = false

    /** True once this attempt has already logged an exchange_window_search_miss
     * entry -- caps it to once per attempt so a prolonged background period
     * (repeated 500ms polls all missing) doesn't spam Diagnostics. */
    @Volatile
    private var windowSearchMissLogged: Boolean = false

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
        pinSubmitted = false
        lastPreConfirmText = null
        lastPostConfirmText = null
        lockedPackageName = null
        lastLoggedMismatchPackage = null
        postPinConfirmationTapped = false
        windowSearchMissLogged = false
        stopPinPolling()
        armed = true
    }

    fun disarm() {
        armed = false
        pendingPinToInject = null
        pinSubmitted = false
        lastPreConfirmText = null
        lastPostConfirmText = null
        lockedPackageName = null
        lastLoggedMismatchPackage = null
        windowSearchMissLogged = false
        postPinConfirmationTapped = false
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

    /** True the first time this exact dialog text is seen *for the current
     * stage* (Step 1's pre-PIN confirm vs Step 3's post-PIN confirm — see
     * [currentConfirmationStage]) during the current attempt — and
     * remembers it, so a repeat scan of the same still-on-screen
     * confirmation dialog (multiple accessibility events can fire before
     * the tap actually dismisses it) never taps its button twice. A
     * different dialog text (the next step in a multi-screen confirm flow)
     * is allowed through again. Stages are tracked independently so an
     * identically-worded Step 1 and Step 3 screen never collide. */
    internal fun shouldAutoConfirm(dialogText: String): Boolean {
        return if (pinSubmitted) {
            if (dialogText == lastPostConfirmText) false else { lastPostConfirmText = dialogText; true }
        } else {
            if (dialogText == lastPreConfirmText) false else { lastPreConfirmText = dialogText; true }
        }
    }

    /** Which real step a confirm screen being auto-tapped right now belongs
     * to: Step 1 (pre-PIN) if the PIN hasn't been submitted yet this
     * attempt, Step 3 (post-PIN) if it has. */
    internal fun currentConfirmationStage(): ConfirmationStage =
        if (pinSubmitted) ConfirmationStage.POST_PIN else ConfirmationStage.PRE_PIN

    /** True if [packageName] is the window already confirmed as this
     * attempt's real carrier dialog, or if no window has been confirmed
     * yet (in which case [packageName] becomes the locked window). False
     * means the foreground has drifted to a different app mid-attempt --
     * its content must never be read as carrier output. */
    internal fun isWindowAllowed(packageName: String?): Boolean {
        val locked = lockedPackageName
        if (locked == null) {
            lockedPackageName = packageName
            return true
        }
        return packageName != null && packageName == locked
    }

    /** True the first time this attempt fails to find its locked window
     * among the currently visible windows -- caps the diagnostic log to
     * once per attempt. */
    internal fun shouldLogWindowSearchMiss(): Boolean {
        if (windowSearchMissLogged) return false
        windowSearchMissLogged = true
        return true
    }

    /** The package this attempt has locked onto, once established --
     * lets the service actively search for that specific window across
     * every currently visible window, not only the active one. */
    internal fun lockedWindowPackageOrNull(): String? = lockedPackageName

    /** True the first time a given off-target package is seen this
     * attempt, so a window mismatch logs once instead of on every 500ms
     * poll while the wrong app stays foregrounded. */
    internal fun shouldLogWindowMismatch(packageName: String?): Boolean {
        if (packageName == lastLoggedMismatchPackage) return false
        lastLoggedMismatchPackage = packageName
        return true
    }

    internal fun emit(event: UssdDialogEvent) {
        if (event is UssdDialogEvent.PinSubmitted) pinSubmitted = true
        if (event is UssdDialogEvent.ConfirmationAdvanced && event.stage == ConfirmationStage.POST_PIN) {
            postPinConfirmationTapped = true
        }
        events.trySend(event)
    }

    /** True while a post-PIN screen should still be evaluated as a
     * possible Step 3 confirm-tap target rather than read as final content
     * -- i.e. the PIN has been submitted, but no Step 3 screen has been
     * auto-tapped yet this attempt. */
    internal fun isEligibleForPostPinConfirmTap(): Boolean =
        pinSubmitted && !postPinConfirmationTapped

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
