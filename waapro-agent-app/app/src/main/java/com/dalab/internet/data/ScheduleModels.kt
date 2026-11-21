package com.dalab.internet.data

/** Schedule Transaction: the networks and packages an agent can schedule. */
data class ScheduleOptions(
    val companies: List<ScheduleCompany> = emptyList(),
    val maxDays: Int = 60,
)

data class ScheduleCompany(
    val id: String,
    val name: String,
    val status: String? = null,
    val colorHex: String? = null,
    val packages: List<SchedulePackage> = emptyList(),
)

data class SchedulePackage(
    val id: String,
    val name: String,
    val price: Double,
)

data class ScheduleOrderRequest(
    val customerName: String,
    val customerPhone: String,
    val companyId: String,
    val packageId: String,
    val receiverPhone: String,
    /** ISO-8601 instant. */
    val scheduledAt: String,
    /** "prepaid" or "pay_at_execution". */
    val paymentMode: String,
    val note: String? = null,
    val clientRequestId: String,
)
