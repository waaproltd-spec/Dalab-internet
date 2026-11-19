package com.dalab.internet.data

// JSON the server sends/receives for Register Customer and per-agent
// services. Kept in this package on purpose: the release build's R8 rules
// keep com.dalab.internet.data.** intact for Gson (proguard-rules.pro);
// outside it, field names get renamed and every request fails to parse.

data class RegistrationNetwork(val id: String = "", val name: String = "", val status: String? = null, val colorHex: String? = null)
data class RegistrationOptions(val networks: List<RegistrationNetwork>? = null)
data class RegisterCustomerRequest(val name: String, val senderPhone: String, val receiverPhone: String, val companyId: String)

data class RegisteredCustomer(
    val id: String = "",
    val name: String? = null,
    val senderNumber: String? = null,
    val receiverNumber: String? = null,
    val companyId: String? = null,
    val companyName: String? = null,
    val companyColor: String? = null,
    val registeredByAgentAt: String? = null,
    val orders: Int? = null,
    val delivered: Int? = null,
    val failed: Int? = null,
    val totalPaid: Double? = null,
    val lastOrderAt: String? = null,
    val openPaymentIssues: Int? = null,
    val created: Boolean? = null,
)

data class RegistrationOrder(
    val id: String = "",
    val customerName: String? = null,
    val amount: Double? = null,
    val createdAt: String? = null,
    val receiverPhone: String? = null,
    val companyName: String? = null,
    val packageName: String? = null,
    val transactionRef: String? = null,
    val paymentState: String? = null,
    val deliveryState: String? = null,
)

data class RegistrationIssue(
    val id: String = "",
    val customerId: String? = null,
    val customerName: String? = null,
    val senderPhone: String? = null,
    val amount: Double? = null,
    val transactionRef: String? = null,
    val reason: String? = null,
    val createdAt: String? = null,
    val resolvedAt: String? = null,
)

data class RegisteredCustomerDetail(
    val id: String = "",
    val name: String? = null,
    val senderNumber: String? = null,
    val receiverNumber: String? = null,
    val companyName: String? = null,
    val registeredByAgentAt: String? = null,
    val totalPaid: Double? = null,
    val orders: List<RegistrationOrder>? = null,
    val paymentIssues: List<RegistrationIssue>? = null,
)


/** GET /agent/me/services: the services the Owner allowed this agent. */
data class MyServicesResponse(val services: List<String>? = null, val all: List<String>? = null)
