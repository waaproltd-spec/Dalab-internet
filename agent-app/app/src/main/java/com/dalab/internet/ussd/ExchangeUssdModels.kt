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
}
