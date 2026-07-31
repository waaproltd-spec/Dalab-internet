package com.sahal.data.ussd

/** Mirrors GET /agent/sim-routing. */
data class SimRoutingEntry(
    val companyId: String,
    val simSlot: Int, // 1 or 2, matching the Super Admin's SIM Routing Setup page
    val companyName: String,
)

/**
 * A physical SIM subscription actually present on the device, resolved via
 * SubscriptionManager. simSlotIndex is 0-based (Android's native indexing);
 * the Super Admin's "SIM 1 / SIM 2" language is 1-based, so callers add 1
 * when comparing — see UssdDialer.slotIndexForCompany().
 */
data class DeviceSimSlot(
    val subscriptionId: Int,
    val simSlotIndex: Int, // 0-based
    val carrierName: String,
)

// DUPLICATE_SKIPPED: another in-flight call on this device is already
// processing this exact order (see UssdOrchestrator's per-order dial lock) --
// distinct from SUCCESS/FAILED since no dial decision was made here at all.
enum class DialOutcome { SUCCESS, FAILED, TIMEOUT, NO_SIM_CONFIGURED, NO_SIM_PRESENT, PERMISSION_DENIED, NETWORK_UNAVAILABLE, DUPLICATE_SKIPPED }

data class DialResult(
    val outcome: DialOutcome,
    val responseMessage: String? = null,
)

/**
 * Distinguishes "this company genuinely has no SIM routing configured" from
 * "the very first refresh call failed on a transient network blip" — both
 * previously collapsed to a bare null, which UssdOrchestrator treated as the
 * terminal NO_SIM_CONFIGURED outcome even for a cold-start connectivity hiccup,
 * dropping the durable retry-queue entry for what was really just a network
 * problem (only NETWORK_UNAVAILABLE keeps that entry alive).
 */
sealed class SimSlotResult {
    data class Slot(val slot: Int) : SimSlotResult()
    object NotConfigured : SimSlotResult()
    object LoadFailed : SimSlotResult()
}

/**
 * Distinguishes "this slot genuinely has no SIM inserted right now" from
 * "we can't tell, because CALL_PHONE/READ_PHONE_STATE isn't granted" — both
 * previously collapsed to the same null from UssdDialer.subscriptionIdForSlot,
 * producing the identical "SIM isn't physically inserted" message for a lost
 * permission as for a truly missing SIM.
 */
sealed class SubscriptionLookupResult {
    data class Found(val subscriptionId: Int) : SubscriptionLookupResult()
    object PermissionMissing : SubscriptionLookupResult()
    object NotPresent : SubscriptionLookupResult()
}
