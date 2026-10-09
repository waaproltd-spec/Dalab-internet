package com.dalab.internet.notifications

/**
 * Remembers which alert events this app has already shown, so one event
 * creates exactly one notification/sound however many times it's delivered
 * (the live stream and the FCM push both deliver every support alert, FCM
 * can redeliver, and the stream replays nothing but may reconnect).
 *
 * Keys are stable ids derived from the event itself (see [keyFor]) -- never
 * a timestamp of when it arrived -- so a repeat always maps to the same key.
 * Bounded to the most recent [capacity] keys; thread-safe.
 */
class AlertDeduper(private val capacity: Int = 300) {
    private val seen = object : LinkedHashMap<String, Boolean>(64, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>?) = size > capacity
    }

    /** True if [key] was already handled. */
    fun isSeen(key: String): Boolean = synchronized(seen) { seen.containsKey(key) }

    /** True if [key] is new (and records it); false if it was already handled. */
    fun markSeen(key: String): Boolean = synchronized(seen) {
        if (seen.containsKey(key)) {
            false
        } else {
            seen[key] = true
            true
        }
    }

    companion object {
        /**
         * The stable key for one support alert: one per assignment, one per
         * waiting customer, one per message id. A message alert without an id
         * (only from an older backend) falls back to its conversation + text,
         * which is still the same on every redelivery.
         */
        fun keyFor(alert: String, conversationId: String, messageId: String?, fallbackText: String? = null): String = when (alert) {
            "assigned" -> "assigned:$conversationId"
            "waiting" -> "waiting:$conversationId"
            else -> messageId?.takeIf { it.isNotBlank() } ?: "message:$conversationId:${fallbackText.orEmpty().hashCode()}"
        }
    }
}
