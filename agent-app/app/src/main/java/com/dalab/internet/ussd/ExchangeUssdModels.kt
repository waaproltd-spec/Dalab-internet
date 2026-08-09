package com.dalab.internet.ussd

/**
 * Outcomes for the Money Exchange automated 2-step USSD payout engine.
 * Deliberately a separate enum from [DialOutcome] (Internet Store) — the two
 * dialing mechanisms are structurally different (see ExchangeUssdDialer vs
 * UssdDialer) and must never be confused with each other.
 */
enum class ExchangeDialOutcome {
    SUCCESS,
    STEP1_FAILED,
    STEP2_FAILED,
    TIMEOUT,
    PERMISSION_DENIED,
    NO_SIM_PRESENT,
    ACCESSIBILITY_NOT_ENABLED,
    NETWORK_UNAVAILABLE,
    DUPLICATE_SKIPPED,
}

data class ExchangeDialResult(
    val outcome: ExchangeDialOutcome,
    val message: String? = null,
)

/** Events the accessibility service reports as it watches the native USSD reply dialog. */
sealed class UssdDialogEvent {
    data class DialogSeen(val text: String, val hasInput: Boolean) : UssdDialogEvent()
    object PinSubmitted : UssdDialogEvent()

    /** An intermediate dialog with no input field but a recognizable
     * Send/OK/Dial/Yes button was auto-confirmed — not the carrier's final
     * answer, so the orchestrator should keep waiting rather than treat
     * this as [DialogSeen]. Some carrier flows show a plain "confirm this
     * transfer?" step before the PIN prompt; without this, that step was
     * indistinguishable from a genuine no-PIN-prompt error and failed the
     * whole attempt immediately. */
    object ConfirmationAdvanced : UssdDialogEvent()
}
