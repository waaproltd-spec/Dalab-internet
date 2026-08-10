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
     * this as [DialogSeen]. [stage] distinguishes which real step this
     * screen belongs to: [ConfirmationStage.PRE_PIN] is a plain "confirm
     * this transfer?" step some carrier flows show before the PIN prompt
     * (Step 1) — without handling it, that step was indistinguishable from
     * a genuine no-PIN-prompt error and failed the whole attempt
     * immediately. [ConfirmationStage.POST_PIN] is a *separate* OK/Send/Yes
     * confirmation screen some carrier flows show after the PIN is
     * submitted (Step 3) — before this, it was silently treated the same
     * as the pre-PIN case, sharing its dedup tracking and producing no
     * diagnostics of its own. */
    data class ConfirmationAdvanced(val stage: ConfirmationStage) : UssdDialogEvent()
}

/** Which real step a [UssdDialogEvent.ConfirmationAdvanced] screen belongs
 * to — [PRE_PIN] (Step 1, before the PIN prompt) or [POST_PIN] (Step 3, the
 * separate confirmation screen after the PIN has been submitted). */
enum class ConfirmationStage { PRE_PIN, POST_PIN }
