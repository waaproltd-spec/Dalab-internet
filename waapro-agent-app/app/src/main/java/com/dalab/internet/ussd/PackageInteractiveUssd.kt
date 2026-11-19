package com.dalab.internet.ussd

import android.content.Context
import android.os.PowerManager
import com.dalab.internet.diagnostics.DiagnosticsLog

/**
 * Menu-driven (interactive) package delivery -- e.g. Somtel Dhameys Plus:
 *   *101#  ->  4  ->  package option  ->  2 (for another number)  ->
 *   receiver number  ->  eDahab PIN
 * The backend renders the order's plan (orders.ussd_plan, see the backend's
 * utils/interactiveUssd.ts) from the admin's Dhameys Plus settings; this
 * file drives it on the carrier's real dialogs through the same
 * accessibility engine Reseller Withdraw already uses
 * ([ResellerWithdrawalInteractiveUssdBridge] / its service), never a second
 * copy of it.
 *
 * Money safety, in order of importance:
 *  - Before every reply the screen is checked against the plan (expected
 *    words, the package option's price on the menu, and the final
 *    confirmation's amount and receiver number). Any mismatch taps Cancel
 *    and stops BEFORE the PIN -- nothing is paid.
 *  - The PIN is fetched from the server only at the PIN step and lives only
 *    in memory for that one reply; it is never logged or reported.
 *  - After the PIN, only the carrier's own success words complete the
 *    order. Anything unclear is reported "ambiguous" and is never retried
 *    automatically (noRetry), so one payment can't be charged twice.
 */

/** orders.ussd_plan -- PIN-free. */
data class UssdPlan(
    val version: Int = 1,
    val initialDial: String,
    val steps: List<UssdPlanStep>,
    // Nullable: Gson leaves a missing key null even on a non-null type.
    val successKeywords: List<String>? = null,
)

data class UssdPlanStep(
    /** What to type; "{pin}" on the PIN step (see [secret]). */
    val reply: String,
    val expect: List<String>? = null,
    val menuOption: UssdMenuOption? = null,
    val amount: String? = null,
    val number: String? = null,
    val secret: Boolean = false,
)

data class UssdMenuOption(val option: String, val amount: String)

/** Built-in success words for package menus (in addition to the plan's
 * own successKeywords). Somtel's real Dhameys Plus receipt: "Macmiil,
 * waxaad ku guuleysatay inaad = Daily 24 Hrs ugu shubto 620346060." --
 * note the "guuleysatay" spelling, which the one-shot recharge classifier's
 * "guulaysatay" does not match. */
internal val PACKAGE_MENU_SUCCESS_KEYWORDS = listOf("guuleysatay", "guulaysatay", "ugu shubto", "ugu shubtay")

private val DOLLAR_BEFORE = Regex("""\$\s*(\d+(?:\.\d+)?)""")
private val DOLLAR_AFTER = Regex("""(\d+(?:\.\d+)?)\s*\$""")

internal fun dollarAmountsIn(text: String): List<Double> =
    (DOLLAR_BEFORE.findAll(text).map { it.groupValues[1] } + DOLLAR_AFTER.findAll(text).map { it.groupValues[1] })
        .mapNotNull { it.toDoubleOrNull() }
        .toList()

private fun sameAmount(a: Double, b: Double) = kotlin.math.abs(a - b) < 0.005

/** The price the menu lists for [option] ("3. $0.5 = Daily 24 Hrs"), or
 * null if the menu has no such line. */
internal fun menuOptionPrice(text: String, option: String): Double? {
    val pattern = Regex("""(?<![0-9])${Regex.escape(option)}\s*[.)]\s*\$\s*(\d+(?:\.\d+)?)""")
    return pattern.find(text)?.groupValues?.get(1)?.toDoubleOrNull()
}

/** Why the carrier's screen doesn't match this step, or null when it does.
 * Pure (no Android) so every rule is unit-tested -- see
 * PackageInteractiveUssdTest. */
internal fun screenMismatch(step: UssdPlanStep, screenText: String): String? {
    val lower = screenText.lowercase()
    step.expect.orEmpty().firstOrNull { it.isNotBlank() && !lower.contains(it.lowercase()) }?.let {
        return "the screen doesn't mention \"$it\""
    }
    step.menuOption?.let { menu ->
        val listed = menuOptionPrice(screenText, menu.option)
            ?: return "the menu has no option ${menu.option} with a price"
        val wanted = menu.amount.toDoubleOrNull() ?: return "the package price is not valid"
        if (!sameAmount(listed, wanted)) {
            return "option ${menu.option} costs \$${trimAmount(listed)} on the menu, not \$${menu.amount} -- the Somtel menu may have changed"
        }
    }
    step.amount?.let { amount ->
        val wanted = amount.toDoubleOrNull() ?: return "the package price is not valid"
        if (dollarAmountsIn(screenText).none { sameAmount(it, wanted) }) {
            return "the confirmation doesn't show \$$amount"
        }
    }
    step.number?.let { number ->
        val digits = screenText.filter { it.isDigit() }
        if (!digits.contains(number)) return "the confirmation doesn't show the number $number"
    }
    return null
}

private fun trimAmount(value: Double): String =
    if (value == Math.floor(value)) value.toLong().toString() else value.toString()

/** Final carrier message after the PIN. Failure words win; only explicit
 * success words are SUCCESS; anything else is AMBIGUOUS (never success). */
internal fun classifyPackageMenuResponse(text: String?, extraSuccessKeywords: List<String> = emptyList()): DialOutcome {
    if (text.isNullOrBlank()) return DialOutcome.AMBIGUOUS
    val lower = text.lowercase()
    if (FAILURE_RESPONSE_KEYWORDS.any { lower.contains(it) }) return DialOutcome.FAILED
    val success = (PACKAGE_MENU_SUCCESS_KEYWORDS + extraSuccessKeywords).filter { it.isNotBlank() }
    return if (success.any { lower.contains(it.lowercase()) }) DialOutcome.SUCCESS else DialOutcome.AMBIGUOUS
}

/** Validates a plan received from the server before dialing anything. */
internal fun planProblem(plan: UssdPlan): String? {
    if (!Regex("""^\*[0-9*]{1,20}#$""").matches(plan.initialDial.trim())) return "the first USSD code is not valid"
    @Suppress("SENSELESS_COMPARISON")
    if (plan.steps == null || plan.steps.isEmpty()) return "the menu has no steps"
    val pinSteps = plan.steps.withIndex().filter { it.value.secret }
    if (pinSteps.size != 1 || pinSteps[0].index != plan.steps.lastIndex) return "the PIN must be the single last step"
    val pin = plan.steps.last()
    if (pin.amount == null || pin.number == null) return "the PIN step must check the amount and number"
    if (plan.steps.dropLast(1).any { !SAFE_REPLY.matches(it.reply) }) return "a menu reply is not a number, amount or plain text"
    return null
}

/**
 * What a non-PIN reply may be: a menu number, the receiver number, an
 * amount ("0.55") or a short custom text an admin set up for the menu
 * ("Y", "1*2"). Never braces, so an unrendered token like "{pin}" can
 * never be typed into the carrier's menu.
 */
private val SAFE_REPLY = Regex("""^[0-9A-Za-z*#+.\- ]{1,30}$""")

/**
 * Drives one attempt of a plan. The caller ([UssdOrchestrator]) already
 * holds this SIM slot's [UssdSimLock], logs the attempt, and reports the
 * result; this only dials and reads screens.
 */
class PackageInteractiveUssdRunner(private val context: Context) {
    private val dialer = ExchangeUssdDialer(context)
    private val bridge = ResellerWithdrawalInteractiveUssdBridge

    suspend fun execute(orderId: String, plan: UssdPlan, subscriptionId: Int, fetchPin: suspend () -> String?): DialResult {
        planProblem(plan)?.let {
            return DialResult(DialOutcome.FAILED, "This order's menu plan is not valid ($it) — nothing was dialed.", noRetry = true)
        }
        if (!bridge.isAccessibilityServiceEnabled(context)) {
            return DialResult(
                DialOutcome.PERMISSION_DENIED,
                "Automated USSD isn't enabled on this phone — turn on Dalab Agent in Settings > Accessibility, then retry this order.",
            )
        }
        if (!dialer.hasRequiredPermissions()) {
            return DialResult(DialOutcome.PERMISSION_DENIED, "Phone permissions aren't granted — check Settings > Apps > Dalab Agent > Permissions.")
        }

        @Suppress("DEPRECATION")
        val wakeLock = (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)
            ?.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                "DalabAgent:PackageMenuUssdDial",
            )
        // The PIN is fetched BEFORE dialing (with retries): on a slow or
        // dropping connection, fetching it at the PIN step could stall
        // while the carrier's menu times out. No PIN, no dial -- nothing
        // is paid. It lives only in memory for this one attempt.
        val pin = fetchPinWithRetry(fetchPin)
            ?: return DialResult(DialOutcome.FAILED, "Couldn't get the provider PIN from the server — nothing was dialed, nothing was paid.", moneyNotSent = true)

        bridge.acquireSession()
        wakeLock?.acquire(240_000)
        bridge.activeWakeLock = wakeLock
        bridge.arm(plan.steps.size)
        try {
            try {
                dialer.dial(subscriptionId, plan.initialDial)
            } catch (e: Exception) {
                DiagnosticsLog.record("package_menu_dial", "Dial threw (order $orderId): ${e.message}", isError = true)
                return DialResult(DialOutcome.FAILED, "Could not start the dial: ${e.message}")
            }
            val result = InteractiveMenuDriver.run(plan, pin, BridgePort(), now = { System.currentTimeMillis() })
            if (result.outcome != DialOutcome.SUCCESS) {
                DiagnosticsLog.record("package_menu_result", "Order $orderId: ${result.outcome} — ${result.responseMessage}", isError = true)
            }
            return result
        } finally {
            bridge.disarm()
            bridge.releaseSession()
            if (wakeLock?.isHeld == true) wakeLock.release()
            bridge.activeWakeLock = null
        }
    }

    private suspend fun fetchPinWithRetry(fetchPin: suspend () -> String?): String? {
        repeat(PIN_FETCH_TRIES) { attempt ->
            fetchPin()?.let { return it }
            if (attempt < PIN_FETCH_TRIES - 1) kotlinx.coroutines.delay(2_000L * (attempt + 1))
        }
        return null
    }

    /** The real phone behind [InteractiveMenuDriver]: the accessibility service's events. */
    private inner class BridgePort : CarrierScreenPort {
        override suspend fun nextScreen(timeoutMs: Long, drain: Boolean): CarrierScreen? {
            val screen = awaitScreen(timeoutMs, drain) ?: return null
            return CarrierScreen(screen.text, screen.hasInput)
        }

        override suspend fun reply(text: String, timeoutMs: Long): Boolean {
            bridge.armReplyInjection(text)
            return awaitSubmitted(timeoutMs)
        }

        override suspend fun cancel() = cancelDialog()

        override suspend fun finalText(timeoutMs: Long): String? = awaitFinalText(timeoutMs)
    }

    private data class Screen(val text: String, val hasInput: Boolean)

    private companion object {
        /** Tries to get the provider PIN before dialing. */
        const val PIN_FETCH_TRIES = 3
    }

    /** Next real carrier screen; auto-tapped confirmations are skipped. */
    private suspend fun awaitScreen(timeoutMs: Long, drain: Boolean = true): Screen? {
        if (drain) bridge.drainStaleEvents()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) return null
            when (val event = bridge.awaitNextEvent(remaining)) {
                is UssdDialogEvent.DialogSeen -> return Screen(event.text, event.hasInput)
                is UssdDialogEvent.ConfirmationAdvanced -> continue
                null -> return null
                else -> continue
            }
        }
    }

    private suspend fun awaitSubmitted(timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) return false
            when (bridge.awaitNextEvent(remaining)) {
                UssdDialogEvent.PinSubmitted -> return true
                null -> return false
                else -> continue
            }
        }
    }

    /** The receipt after the PIN: an OK-only screen is auto-tapped by the
     * service (ConfirmationAdvanced, carrying its text) or seen directly. */
    private suspend fun awaitFinalText(timeoutMs: Long): String? {
        bridge.drainStaleEvents()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) return null
            when (val event = bridge.awaitNextEvent(remaining)) {
                is UssdDialogEvent.DialogSeen -> return event.text
                is UssdDialogEvent.ConfirmationAdvanced -> if (event.text.isNotBlank()) return event.text
                null -> return null
                else -> continue
            }
        }
    }

    /** Best effort: back out of the dialog (Cancel). Never presses Send. */
    private suspend fun cancelDialog() {
        bridge.armDialogCancellation()
        val deadline = System.currentTimeMillis() + 5_000L
        while (true) {
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) return
            when (bridge.awaitNextEvent(remaining)) {
                UssdDialogEvent.DialogCancelled, null -> return
                else -> continue
            }
        }
    }
}
