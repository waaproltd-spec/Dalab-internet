package com.dalab.internet.ussd

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeoutOrNull

/**
 * In-process bridge between [ResellerWithdrawalInteractiveUssdAccessibilityService]
 * (reads and drives the native USSD reply dialog) and
 * [ResellerWithdrawalInteractiveUssdOrchestrator] (decides what each dialog
 * means and what to type next). Generalizes [ExchangeUssdBridge]'s exact
 * shape from a single fixed PIN slot to an arbitrary ordered sequence of
 * replies — eDahab's Reseller Service menu is more than two turns (menu
 * selection, destination number, amount, then the PIN), unlike Money
 * Exchange's fixed two-step (number+amount, then PIN) flow. At any moment
 * there is still only ever at most one pending reply to inject — the
 * orchestrator arms the next one each time a reply is confirmed submitted,
 * same one-at-a-time model Exchange already proved out, just re-armed
 * repeatedly instead of once.
 *
 * Every window-lock/recovery/dialog-detection heuristic this depends on
 * (via [ResellerWithdrawalInteractiveUssdAccessibilityService]) is the exact
 * same proven logic [ExchangeUssdAccessibilityService] already uses in
 * production — copied, not shared, so this new eDahab flow can never affect
 * Money Exchange's own working automation.
 *
 * A reply is held here only for the seconds it takes the service to fill it
 * in — never logged, never persisted, never exposed outside this process.
 * The PIN travels through here exactly like any other reply (it's always
 * the LAST one in the sequence the orchestrator arms) — see
 * ResellerWithdrawalInteractiveUssdOrchestrator for where the reply queue is
 * actually built.
 */
object ResellerWithdrawalInteractiveUssdBridge {

    @Volatile
    var serviceConnected: Boolean = false
        internal set

    @Volatile
    var armed: Boolean = false
        private set

    @Volatile
    private var pendingReplyToInject: String? = null

    /** How many replies have been successfully submitted so far this
     * attempt — the generalized stage discriminator [shouldAutoConfirm]
     * uses to dedupe an auto-tapped confirm screen, replacing Exchange's
     * boolean pinSubmitted/two-stage (PRE_PIN/POST_PIN) split with an
     * arbitrary number of stages, one per reply already sent. */
    @Volatile
    private var repliesSubmittedCount: Int = 0

    /** Dedup text per stage (see [repliesSubmittedCount]) — an identically-
     * worded confirm screen appearing at two different stages must never be
     * conflated, same reasoning as Exchange's lastPreConfirmText/
     * lastPostConfirmText, just generalized to N stages instead of 2. */
    private val lastAutoConfirmTextByStage = HashMap<Int, String>()

    @Volatile
    private var lockedPackageName: String? = null

    @Volatile
    private var lockedWindowId: Int? = null

    @Volatile
    private var lastLoggedMismatchPackage: String? = null

    /** Caps the auto-confirm tap to once per stage — see [repliesSubmittedCount]
     * and [ExchangeUssdBridge.postPinConfirmationTapped] for the identical
     * reasoning generalized from 2 stages to N. */
    private val autoConfirmTappedByStage = HashSet<Int>()

    @Volatile
    private var windowSearchMissLogged: Boolean = false

    @Volatile
    private var recoveryAttemptCount: Int = 0

    @Volatile
    private var recoveryInProgress: Boolean = false

    private const val MAX_RECOVERY_ATTEMPTS = 4

    @Volatile
    private var pinFieldMissLogged: Boolean = false

    @Volatile
    var activeWakeLock: PowerManager.WakeLock? = null

    private var events = Channel<UssdDialogEvent>(capacity = Channel.CONFLATED)

    private val mainHandler = Handler(Looper.getMainLooper())
    private var replyPollRunnable: Runnable? = null
    private const val REPLY_POLL_INTERVAL_MS = 500L

    fun isAccessibilityServiceEnabled(context: Context): Boolean {
        val enabled = Settings.Secure.getString(
            context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val expected = "${context.packageName}/${ResellerWithdrawalInteractiveUssdAccessibilityService::class.java.name}"
        return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
    }

    /** How many replies this attempt will submit in total (including the
     * PIN) — set once by [arm] and never changed for the life of the
     * attempt. The only stage eligible for a blind confirm-tap is the one
     * AFTER every reply has already been submitted (the final receipt
     * screen) — see [isEligibleForConfirmTapAtCurrentStage]'s doc comment
     * for why every earlier stage must never blind-tap. */
    @Volatile
    private var totalReplies: Int = 0

    /** Starts a fresh watch session — a new channel so a stale event from a
     * previous, already-finished attempt can never be misread as belonging
     * to this one. [replyCount] is the total number of replies this attempt
     * will submit (see [totalReplies]). */
    fun arm(replyCount: Int) {
        events = Channel(capacity = Channel.CONFLATED)
        pendingReplyToInject = null
        repliesSubmittedCount = 0
        totalReplies = replyCount
        lastAutoConfirmTextByStage.clear()
        autoConfirmTappedByStage.clear()
        lockedPackageName = null
        lockedWindowId = null
        lastLoggedMismatchPackage = null
        windowSearchMissLogged = false
        pinFieldMissLogged = false
        recoveryAttemptCount = 0
        recoveryInProgress = false
        stopReplyPolling()
        armed = true
    }

    fun disarm() {
        armed = false
        pendingReplyToInject = null
        lockedPackageName = null
        lockedWindowId = null
        lastLoggedMismatchPackage = null
        windowSearchMissLogged = false
        pinFieldMissLogged = false
        recoveryAttemptCount = 0
        recoveryInProgress = false
        stopReplyPolling()
    }

    /** Tells the service to fill+submit this reply into the next
     * input-bearing dialog it sees, then actively re-checks the currently
     * foregrounded window at a short interval until it's consumed or the
     * attempt ends — same reasoning as [ExchangeUssdBridge.armPinInjection]:
     * the reply field can render a beat after the window appears, and some
     * OEM dialogs never fire a second accessibility event once drawn. */
    fun armReplyInjection(reply: String) {
        pendingReplyToInject = reply
        startReplyPolling()
    }

    private fun startReplyPolling() {
        stopReplyPolling()
        val runnable = object : Runnable {
            override fun run() {
                if (!armed || pendingReplyToInject == null) return
                ResellerWithdrawalInteractiveUssdAccessibilityService.instance?.scanAndAct()
                if (armed && pendingReplyToInject != null) {
                    mainHandler.postDelayed(this, REPLY_POLL_INTERVAL_MS)
                }
            }
        }
        replyPollRunnable = runnable
        mainHandler.post(runnable)
    }

    private fun stopReplyPolling() {
        replyPollRunnable?.let(mainHandler::removeCallbacks)
        replyPollRunnable = null
    }

    internal fun consumePendingReplyToInject(): String? {
        val reply = pendingReplyToInject
        pendingReplyToInject = null
        return reply
    }

    internal fun restorePendingReplyToInject(reply: String) {
        pendingReplyToInject = reply
    }

    internal fun shouldAutoConfirm(dialogText: String): Boolean {
        val stage = repliesSubmittedCount
        return if (lastAutoConfirmTextByStage[stage] == dialogText) false else {
            lastAutoConfirmTextByStage[stage] = dialogText
            true
        }
    }

    internal fun currentStage(): Int = repliesSubmittedCount

    internal fun isWindowAllowed(packageName: String?, windowId: Int?, looksLikeUssdDialog: Boolean): Boolean {
        val locked = lockedPackageName
        if (locked == null) {
            if (!looksLikeUssdDialog) return false
            lockedPackageName = packageName
            lockedWindowId = windowId
            return true
        }
        if (packageName != null && packageName == locked) return true
        val lockedId = lockedWindowId
        return lockedId != null && windowId != null && windowId == lockedId
    }

    internal fun shouldLogWindowSearchMiss(): Boolean {
        if (windowSearchMissLogged) return false
        windowSearchMissLogged = true
        return true
    }

    internal fun shouldAttemptWindowRecovery(): Boolean {
        if (recoveryInProgress || recoveryAttemptCount >= MAX_RECOVERY_ATTEMPTS) return false
        recoveryAttemptCount++
        recoveryInProgress = true
        return true
    }

    internal fun recoveryAttemptFinished() {
        recoveryInProgress = false
    }

    internal fun shouldLogPinFieldMiss(): Boolean {
        if (pinFieldMissLogged) return false
        pinFieldMissLogged = true
        return true
    }

    internal fun lockedWindowPackageOrNull(): String? = lockedPackageName

    internal fun lockedWindowIdOrNull(): Int? = lockedWindowId

    internal fun shouldLogWindowMismatch(packageName: String?): Boolean {
        if (packageName == lastLoggedMismatchPackage) return false
        lastLoggedMismatchPackage = packageName
        return true
    }

    internal fun emit(event: UssdDialogEvent) {
        if (event is UssdDialogEvent.PinSubmitted) repliesSubmittedCount++
        if (event is UssdDialogEvent.ConfirmationAdvanced) {
            autoConfirmTappedByStage.add(currentStage())
        }
        events.trySend(event)
    }

    /** True while a screen at the current stage should still be evaluated as
     * a possible confirm-tap target rather than read as final content.
     * Mirrors [ExchangeUssdBridge.isEligibleForPostPinConfirmTap] generalized
     * to any stage — but critically, ONLY once every reply (including the
     * PIN) has already been submitted this attempt, i.e. only for the truly
     * final receipt screen. Every earlier stage still expects a real typed
     * reply next, exactly like Exchange's own PRE_PIN stage does — Exchange
     * only ever has one reply (the PIN) so "before it's submitted" and
     * "every stage before the last" happen to be the same thing there; this
     * flow has several replies in a row ("3", number, amount, PIN), so
     * generalizing "PRE_PIN" to merely "stage > 0" would still blind-tap
     * every one of those intermediate reply screens once past stage 0.
     *
     * Confirmed live as a real bug, not theoretical, in an earlier version
     * of this check that used `stage > 0`: at stage 0 (before the very
     * first reply — the menu selection "3" — has been typed), it returned
     * true unconditionally whenever nothing had been auto-tapped yet at
     * that stage. Combined with the accessibility service's
     * `inputNode == null || isEligibleForConfirmTapAtCurrentStage()` check,
     * that meant the genuine first menu screen (which DOES have a real
     * input field waiting for "3") got blind-tapped as a "confirm screen"
     * instead of receiving the typed reply — submitting an empty USSD
     * response to the carrier. Confirmed against the real eDahab flow
     * (production diagnostics, 2026-08-19 ~01:16-01:23 UTC): a window
     * locked onto com.android.phone (the real *300# menu appeared), a
     * confirmation_advanced event fired immediately after with no reply
     * ever armed, the on-device toast read "Input required. Try again."
     * (Android/carrier's response to a blank USSD reply), and the window
     * was gone on the next scan. */
    internal fun isEligibleForConfirmTapAtCurrentStage(): Boolean =
        isConfirmTapEligible(currentStage(), totalReplies, currentStage() in autoConfirmTappedByStage)

    internal fun drainStaleEvents() {
        while (events.tryReceive().isSuccess) {
            // discard
        }
    }

    suspend fun awaitNextEvent(timeoutMs: Long): UssdDialogEvent? = withTimeoutOrNull(timeoutMs) {
        events.receive()
    }
}

/** Pulled out of [ResellerWithdrawalInteractiveUssdBridge.isEligibleForConfirmTapAtCurrentStage]
 * as a pure function (no Android/object-state dependency, since the bridge
 * object itself can't run in a plain JVM test — it constructs a
 * `Handler(Looper.getMainLooper())` at load time) so the exact eligibility
 * rule can be unit-tested directly — see
 * ResellerWithdrawalInteractiveUssdBridgeTest. `stage` is how many replies
 * have been submitted so far this attempt (0 before the first); a screen is
 * only eligible for a blind confirm-tap once `stage == totalReplies` — i.e.
 * every reply, including the PIN, has already been sent and there is
 * nothing left to type — matching the true final receipt screen. Any
 * earlier stage still expects a real typed reply next and must never be
 * blind-tapped. */
internal fun isConfirmTapEligible(stage: Int, totalReplies: Int, alreadyTappedThisStage: Boolean): Boolean =
    stage >= totalReplies && !alreadyTappedThisStage
