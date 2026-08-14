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
    // Nullable, not List<SupportMessage> = emptyList() — Gson builds this
    // class via reflection and only ever calls the no-arg path for fields
    // it can't find in the JSON, which sets them to null and skips the
    // Kotlin default entirely. The queue-list endpoint never sends a
    // "messages" key at all (only single-ticket responses do), so a
    // non-nullable field here is silently null at runtime despite the
    // type, and the first thing that calls .size on it crashes.
    val messages: List<SupportMessage>? = null,
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
