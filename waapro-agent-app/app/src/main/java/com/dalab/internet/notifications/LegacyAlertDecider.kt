package com.dalab.internet.notifications

/**
 * Pure decision for a support event that came without an `alert` field
 * (an older backend): is there something new for this agent to be alerted
 * about? Only very recent events count, so reopening the app or the live
 * connection reconnecting never re-alerts an old request or message.
 */
object LegacyAlertDecider {
    /** How recent an assignment/message must be to still be "new". */
    const val RECENT_MS = 3 * 60 * 1000L

    data class Decision(val alert: String, val key: String)

    private fun recent(atMs: Long?, nowMs: Long) = atMs != null && nowMs - atMs in -RECENT_MS..RECENT_MS

    fun forActiveConversation(
        conversationId: String,
        assignedAtMs: Long?,
        latestCustomerMessageId: String?,
        latestCustomerMessageAtMs: Long?,
        nowMs: Long,
    ): Decision? {
        // Just connected to this customer -> one "needs help" alert.
        if (recent(assignedAtMs, nowMs)) return Decision("assigned", AlertDeduper.keyFor("assigned", conversationId, null))
        // Otherwise a new customer message, keyed by its own id.
        if (latestCustomerMessageId != null && recent(latestCustomerMessageAtMs, nowMs)) {
            return Decision("message", AlertDeduper.keyFor("message", conversationId, latestCustomerMessageId))
        }
        return null
    }

    fun forWaiting(conversationId: String, createdAtMs: Long?, nowMs: Long): Decision? =
        if (recent(createdAtMs, nowMs)) Decision("waiting", AlertDeduper.keyFor("waiting", conversationId, null)) else null
}
