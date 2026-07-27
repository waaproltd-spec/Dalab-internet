package com.dalab.internet.ussd

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

enum class DialOutcome { SUCCESS, FAILED, TIMEOUT, NO_SIM_CONFIGURED, NO_SIM_PRESENT, PERMISSION_DENIED, NETWORK_UNAVAILABLE }

data class DialResult(
    val outcome: DialOutcome,
    val responseMessage: String? = null,
)
