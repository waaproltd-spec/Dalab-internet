package com.dalab.internet.ussd

/**
 * Safety rules for every automated, on-screen USSD flow (menu packages,
 * Reseller Withdraw, Money Exchange), kept free of Android so each rule is
 * unit-tested on a plain JVM (see UssdSafetyTest):
 *
 *  - [CarrierWindowFilter]: only the carrier's USSD dialog is ever read or
 *    typed into -- never the keyboard, an overlay, this app's own screens
 *    (Register Customer form...), the launcher or a chat app.
 *  - [awaitSettledScreen]: a screen is used only once it has stopped
 *    changing (slow networks draw menus late and in parts).
 *  - [InteractiveMenuDriver]: runs a menu package plan step by step; every
 *    step's screen is verified before anything is typed, a mismatch stops
 *    BEFORE the PIN, a slow carrier is waited for (never skipped), and once
 *    the PIN has gone out an unclear result is never retried.
 *  - [resellerScreenProblem]: Reseller Withdraw has no per-step text in its
 *    settings, so each screen is at least checked for the carrier's error
 *    words before any reply.
 *  - [payoutStartAllowsDial]: a payout is dialed only when the server has
 *    just created a NEW dial record for it -- offline, or a record that
 *    already existed (it was dialed before), means nothing is dialed, so a
 *    dropped connection can never lead to paying the same withdrawal twice.
 */

// ---------------- Which window is the carrier's dialog ----------------

object CarrierWindowFilter {
    // AccessibilityWindowInfo.TYPE_* values (Android framework constants).
    const val TYPE_APPLICATION = 1
    const val TYPE_INPUT_METHOD = 2
    const val TYPE_SYSTEM = 3
    const val TYPE_ACCESSIBILITY_OVERLAY = 4
    const val TYPE_SPLIT_SCREEN_DIVIDER = 5
    const val TYPE_MAGNIFICATION_OVERLAY = 6

    private val NEVER_A_DIALOG_TYPES = setOf(TYPE_INPUT_METHOD, TYPE_ACCESSIBILITY_OVERLAY, TYPE_SPLIT_SCREEN_DIVIDER, TYPE_MAGNIFICATION_OVERLAY)

    /** Apps whose windows are never the carrier's USSD dialog. */
    private val NEVER_A_DIALOG_PACKAGES = setOf(
        // keyboards
        "com.samsung.android.honeyboard", "com.sec.android.inputmethod", "com.google.android.inputmethod.latin",
        "com.touchtype.swiftkey", "com.android.inputmethod.latin", "com.baidu.input_mi", "com.iflytek.inputmethod.miui",
        // system UI and launchers
        "com.android.systemui", "com.sec.android.app.launcher", "com.google.android.apps.nexuslauncher",
        "com.android.launcher3", "com.miui.home", "com.transsion.hilauncher", "com.transsion.XOSLauncher",
        "com.huawei.android.launcher", "com.oppo.launcher", "com.android.launcher",
        // chat apps (chat heads, bubbles) and screen recorders
        "com.facebook.orca", "com.facebook.katana", "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger",
        "com.imo.android.imoim", "com.snapchat.android", "com.zhiliaoapp.musically", "com.ss.android.ugc.trill",
    )

    /**
     * Whether a window may be taken as the carrier's USSD dialog. Unknown
     * apps (every phone maker names its dialog app differently) are allowed
     * only when the window actually looks like a dialog -- an input field,
     * a Send/OK button or the "USSD code running" text.
     */
    fun accept(packageName: String?, windowType: Int?, ownPackage: String?, looksLikeDialog: Boolean): Boolean {
        if (packageName.isNullOrBlank()) return false
        if (ownPackage != null && packageName == ownPackage) return false
        if (windowType != null && windowType in NEVER_A_DIALOG_TYPES) return false
        if (packageName in NEVER_A_DIALOG_PACKAGES) return false
        return looksLikeDialog
    }
}

// ---------------- Waiting for a screen that has stopped changing ----------------

/** One carrier screen as the accessibility service read it. */
data class CarrierScreen(val text: String, val hasInput: Boolean)

/**
 * The next carrier screen, once it has stopped changing: after a screen
 * arrives, it is used only when nothing different follows within
 * [settleMs] (or the very same screen is read again). [next] returns the
 * next screen within the given time, or null; [drainFirst] drops screens
 * read before this call (the previous step's).
 */
suspend fun awaitSettledScreen(
    timeoutMs: Long,
    settleMs: Long,
    now: () -> Long,
    next: suspend (timeoutMs: Long, drain: Boolean) -> CarrierScreen?,
): CarrierScreen? {
    val deadline = now() + timeoutMs
    var current = next(timeoutMs, true) ?: return null
    while (true) {
        val quiet = minOf(settleMs, deadline - now())
        if (quiet <= 0) return current
        val newer = next(quiet, false) ?: return current
        if (newer == current) return current
        current = newer
    }
}

// ---------------- Menu packages (e.g. Somtel Dhameys Plus) ----------------

/** What the menu driver needs from the phone (the real one drives the accessibility service). */
interface CarrierScreenPort {
    /** The next carrier screen (auto-tapped confirmations skipped), or null when none comes in time. */
    suspend fun nextScreen(timeoutMs: Long, drain: Boolean): CarrierScreen?
    /** Types [text] into the dialog and presses Send; true once the service confirmed it. */
    suspend fun reply(text: String, timeoutMs: Long): Boolean
    /** Taps Cancel (best effort). Never presses Send. */
    suspend fun cancel()
    /** The carrier's receipt after the last reply, or null when none comes in time. */
    suspend fun finalText(timeoutMs: Long): String?
}

/** How long to wait at each point. Generous on purpose: slow networks draw menus late. */
data class MenuTimings(
    val firstScreenMs: Long = 45_000L,
    val nextScreenMs: Long = 35_000L,
    val settleMs: Long = 900L,
    val mismatchGraceMs: Long = 4_000L,
    val replyMs: Long = 20_000L,
    val receiptMs: Long = 45_000L,
)

object InteractiveMenuDriver {
    /**
     * Runs [plan] step by step with the [pin] already in hand (fetched
     * before dialing, so a slow server can't stall the PIN step while the
     * carrier's menu times out). Before anything is typed, the step's
     * screen must have settled and must match the plan; a screen that
     * doesn't match yet gets [MenuTimings.mismatchGraceMs] more to change.
     * Every stop before the PIN cancels the dialog and says nothing was
     * paid; after the PIN, only the carrier's own success words count and
     * anything unclear is never retried automatically (noRetry).
     */
    suspend fun run(plan: UssdPlan, pin: String, port: CarrierScreenPort, now: () -> Long, timings: MenuTimings = MenuTimings()): DialResult {
        for ((index, step) in plan.steps.withIndex()) {
            val label = "step ${index + 1} of ${plan.steps.size}"
            var screen = awaitSettledScreen(
                if (index == 0) timings.firstScreenMs else timings.nextScreenMs, timings.settleMs, now,
            ) { t, drain -> port.nextScreen(t, drain) }
                ?: return DialResult(DialOutcome.TIMEOUT, "No response from the carrier at $label — nothing was paid.", moneyNotSent = true)

            val graceUntil = now() + timings.mismatchGraceMs
            while ((!screen.hasInput || screenMismatch(step, screen.text) != null) && now() < graceUntil) {
                screen = awaitSettledScreen(graceUntil - now(), timings.settleMs, now) { t, _ -> port.nextScreen(t, false) } ?: break
            }
            if (!screen.hasInput) {
                // An error or notice instead of the expected menu. Nothing has been paid yet.
                port.cancel()
                return DialResult(DialOutcome.FAILED, "Carrier at $label: \"${screen.text}\" — nothing was paid.")
            }
            screenMismatch(step, screen.text)?.let { reason ->
                port.cancel()
                return DialResult(
                    DialOutcome.FAILED,
                    "Stopped at $label: $reason. Cancelled before the PIN — nothing was paid. Check this USSD service's settings in the dashboard.",
                    noRetry = true,
                )
            }
            val reply = if (step.secret) pin else step.reply
            if (!port.reply(reply, timings.replyMs)) {
                return if (step.secret) {
                    DialResult(DialOutcome.AMBIGUOUS, "Couldn't confirm the PIN was submitted — check the phone and the carrier SMS before retrying.", noRetry = true)
                } else {
                    port.cancel()
                    DialResult(DialOutcome.FAILED, "Couldn't submit $label — nothing was paid.")
                }
            }
        }
        val receipt = port.finalText(timings.receiptMs)
            ?: return DialResult(DialOutcome.AMBIGUOUS, "The PIN was sent but no confirmation came back — check the carrier SMS before retrying.", noRetry = true)
        val outcome = classifyPackageMenuResponse(receipt, plan.successKeywords.orEmpty())
        return DialResult(outcome, receipt, noRetry = outcome != DialOutcome.SUCCESS)
    }
}

// ---------------- Reseller Withdraw ----------------

/** Why a Reseller Withdraw screen must not get the next reply, or null when it may. */
internal fun resellerScreenProblem(screenText: String): String? {
    val lower = screenText.lowercase()
    val word = FAILURE_RESPONSE_KEYWORDS.firstOrNull { lower.contains(it) } ?: return null
    return "the carrier answered with an error (\"$word\")"
}

/** The index of the reply that carries the PIN (a {pin} step, else the last reply). */
internal fun resellerPinIndex(replySteps: List<String>, replyCount: Int): Int =
    replySteps.indexOfFirst { it.contains("{pin}") }.takeIf { it >= 0 } ?: (replyCount - 1)

// ---------------- Payout start: dial only on a NEW server record ----------------

/**
 * A payout may be dialed only when the server answered the start call
 * with 201 -- a dial record created just now. 200 means a record already
 * existed (this payout was dialed before, maybe while the phone was
 * offline); no answer means the server doesn't know about this dial. In
 * both cases nothing is dialed.
 */
fun payoutStartAllowsDial(httpCode: Int?): Boolean = httpCode == 201
