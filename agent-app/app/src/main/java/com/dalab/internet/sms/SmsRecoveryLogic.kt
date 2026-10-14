package com.dalab.internet.sms

import java.security.MessageDigest

/**
 * The Android-free decisions behind reliable SMS intake (unit-tested in
 * SmsRecoveryLogicTest): a stable identity per SMS, which inbox messages a
 * recovery pass still has to handle, and how long a failed upload waits
 * before its next automatic retry.
 *
 * The backend's own dedup (transaction reference, sender+body+minute, one
 * active payment per order -- smsLogs.routes.ts) stays the authoritative
 * guard against crediting a payment twice. These only stop the phone from
 * re-uploading what the server already acknowledged.
 */
object SmsRecoveryLogic {
    /** How far back a recovery pass ever looks. */
    const val LOOKBACK_MS = 24 * 60 * 60 * 1000L
    /** Each pass re-reads this much before the last checkpoint, so an SMS
     * written to the inbox just as the previous pass started is never
     * skipped. Already-handled ones are filtered out by fingerprint. */
    const val OVERLAP_MS = 30 * 60 * 1000L
    /** Passes closer together than this are skipped (one just ran). */
    const val MIN_INTERVAL_MS = 15_000L
    const val BACKOFF_BASE_MS = 30_000L
    const val BACKOFF_MAX_MS = 15 * 60 * 1000L

    /** Stable identity of one SMS: same sender + same text = same SMS,
     * whether it arrived through the live receiver or an inbox pass. Payment
     * SMS carry their own timestamp/reference in the text, so two real
     * payments never share one. */
    fun fingerprint(sender: String, body: String): String {
        val normalized = sender.trim().lowercase() + "\n" + body.trim()
        val digest = MessageDigest.getInstance("SHA-256").digest(normalized.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    /** Oldest SMS date a pass started at [now] still reads. */
    fun recoveryCutoff(lastCheckpoint: Long, now: Long): Long {
        val floor = now - LOOKBACK_MS
        if (lastCheckpoint <= 0L) return floor
        return maxOf(lastCheckpoint - OVERLAP_MS, floor)
    }

    data class InboxMessage(val sender: String, val body: String, val dateMs: Long, val subscriptionId: Int? = null)

    /** The messages a pass still has to handle, oldest first, each SMS once,
     * skipping every one [isHandled] already knows (acknowledged by the
     * server, or durably queued for upload). */
    fun messagesToRecover(messages: List<InboxMessage>, isHandled: (String) -> Boolean): List<InboxMessage> =
        messages
            .sortedBy { it.dateMs }
            .distinctBy { fingerprint(it.sender, it.body) }
            .filterNot { isHandled(fingerprint(it.sender, it.body)) }

    /** Wait before the next automatic retry of an upload that already failed
     * [attemptCount] times: 30s, 60s, 2m, 4m ... capped at 15m. It never
     * gives up -- a real customer payment is never dropped for being slow. */
    fun backoffMs(attemptCount: Int): Long {
        if (attemptCount <= 0) return 0L
        val shift = (attemptCount - 1).coerceAtMost(20)
        return minOf(BACKOFF_BASE_MS shl shift, BACKOFF_MAX_MS)
    }

    /** Whether a queued upload should be tried now. [force] (connectivity just
     * came back) retries everything immediately. */
    fun isDueForRetry(attemptCount: Int, lastAttemptAt: Long, now: Long, force: Boolean): Boolean =
        force || attemptCount <= 0 || now - lastAttemptAt >= backoffMs(attemptCount)
}

/**
 * What the phone knows about each SMS it has taken in (keyed by
 * [SmsRecoveryLogic.fingerprint]): QUEUED = saved for upload, the server
 * hasn't confirmed it yet; ACKED = the server confirmed it (stored, matched,
 * or rejected as a duplicate). Pure so it can be unit-tested; persisted by
 * [SmsFingerprintStore].
 */
class SmsIntakeLedger(private val entries: MutableMap<String, Entry> = mutableMapOf()) {
    enum class State { QUEUED, ACKED }
    data class Entry(val state: State, val at: Long)

    fun state(fingerprint: String): State? = entries[fingerprint]?.state

    fun markQueued(fingerprint: String, now: Long) {
        if (entries[fingerprint]?.state == State.ACKED) return
        entries[fingerprint] = Entry(State.QUEUED, now)
    }

    fun markAcked(fingerprint: String, now: Long) {
        entries[fingerprint] = Entry(State.ACKED, now)
    }

    /** Forgets entries older than [RETENTION_MS] (well past the recovery
     * lookback, so nothing a pass can still see is forgotten) and keeps at
     * most [MAX_ENTRIES], dropping the oldest. */
    fun prune(now: Long) {
        entries.entries.removeAll { now - it.value.at > RETENTION_MS }
        if (entries.size > MAX_ENTRIES) {
            entries.entries.sortedBy { it.value.at }.take(entries.size - MAX_ENTRIES).map { it.key }.forEach { entries.remove(it) }
        }
    }

    fun snapshot(): Map<String, Entry> = entries.toMap()

    companion object {
        const val RETENTION_MS = 7 * 24 * 60 * 60 * 1000L
        const val MAX_ENTRIES = 2000
    }
}
