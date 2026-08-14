package com.dalab.internet.data

/** Mirrors support.routes.ts's support_tickets/support_messages shape. */
data class SupportTicket(
    val id: String,
    val ticketNumber: String,
    val customerId: String? = null,
    val customerName: String? = null,
    val lastMessage: String? = null,
    val waitingMinutes: Double? = null,
    val queue: String, // agent | admin
    val status: String, // waiting | in_progress | resolved
    val subject: String,
    val queueInfo: SupportQueueInfo? = null,
    val messages: List<SupportMessage> = emptyList(),
)

data class SupportQueueInfo(val position: Int, val etaMinutes: Int)

data class SupportMessage(
    val id: String,
    val senderType: String, // customer | ai | agent | admin | system
    val senderId: String? = null,
    val body: String,
    val createdAt: String,
)

data class SupportMessageRequest(val body: String)
