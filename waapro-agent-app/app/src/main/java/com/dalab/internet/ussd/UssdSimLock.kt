package com.dalab.internet.ussd

import com.dalab.internet.diagnostics.DiagnosticsLog
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicLong

/**
 * THE global USSD queue of the Agent App: only ONE USSD session may be
 * active at a time across the whole app -- whatever the flow and whatever
 * the SIM slot.
 *
 * Every flow that dials a real USSD code goes through here, for exactly the
 * span of one dial attempt: Internet Store recharge and its menu packages
 * (UssdOrchestrator / PackageInteractiveUssdRunner), Money Exchange/eBadal
 * payout (ExchangeUssdOrchestrator), its Wallet Name Lookup
 * (WalletLookupUssdOrchestrator), and Reseller Withdraw (both
 * ResellerWithdrawalUssdOrchestrator and
 * ResellerWithdrawalInteractiveUssdOrchestrator). UssdSimLockWiringTest
 * proves each of them acquires and releases it, so no screen or button can
 * start a USSD session around it: the queue lives in the dialing layer
 * itself, not in any screen, and survives every screen change (it is a
 * process-wide singleton).
 *
 * This used to be one queue PER SIM SLOT (two SIMs could dial at the same
 * moment). It is now one queue for the whole app: two SIMs in one phone
 * share one modem and -- for the interactive flows -- one screen, and two
 * overlapping sessions there could abort each other or mix their replies.
 * The public API (acquire(simSlot, ...) / release(ticket)) is unchanged; the
 * SIM slot is kept on each request only to show the agent which SIM it uses.
 *
 * Order: by each request's real arrival time (business creation time where
 * the caller has one, else "now"), then a monotonic sequence number as tie
 * breaker. The first request to reach an IDLE queue waits [debounceMs] so a
 * near-simultaneous sibling can line up in its correct order; afterwards
 * every next request starts immediately when the previous one is released
 * -- completed, failed, timed out or cancelled (callers release in a
 * finally block).
 *
 * Session timeout (safe): every kind of request has a hard time limit
 * ([sessionLimitMs]) well above its own dial timeouts. If a session ever
 * holds the queue past it, the queue -- and only the queue -- moves on:
 *  - the job is NOT retried and NOT marked failed: it is recorded as an
 *    UNCERTAIN timeout ([onSessionTimeout], shown to the agent as "check
 *    before retrying"), because the carrier may still have done it;
 *  - the job keeps its UssdJobRegistry claim until its own code returns, so
 *    the same payment/transaction can never be started a second time while
 *    the stuck one may still be running;
 *  - the next request waits [timeoutCooldownMs] first, so the stuck carrier
 *    session has time to close before a new one is dialed;
 *  - the stuck ticket's late release() is ignored.
 *
 * [status] is what the agent sees: the request that is Running and the
 * ones Waiting, in order.
 */
object UssdSimLock {

    /** Held by whichever request currently owns the app's one USSD session.
     * Must be handed back to [release] exactly once, whatever the outcome. */
    class Ticket internal constructor(internal val simSlot: Int, internal val requestId: String, internal val id: Long)

    private data class Waiter(
        val requestId: String,
        val simSlot: Int,
        val arrivalTimeMs: Long,
        val enqueuedAtMs: Long,
        val sequence: Long,
        val signal: CompletableDeferred<Ticket>,
    )

    /** Real production value; shrunk by tests. */
    internal var debounceMs: Long = 300L

    /** Test-only override of every [sessionLimitMs]. */
    internal var maxSessionOverrideMs: Long? = null

    /** Pause after a timed-out session before the next one starts. */
    internal var timeoutCooldownMs: Long = 5_000L

    /** Hard time limit for one session of [requestId]'s kind -- each is well
     * above that flow's own dial/screen timeouts, so it only ever fires if
     * those failed. */
    fun sessionLimitMs(requestId: String): Long {
        maxSessionOverrideMs?.let { return it }
        return when (normalizeUssdJobKey(requestId).substringBefore(':')) {
            "wallet-lookup" -> 90_000L      // one read step (own timeouts ~45s)
            "exchange" -> 150_000L          // two steps + PIN (wake lock 80s)
            "internet_store" -> 180_000L    // one-shot 30s, menu packages up to ~150s
            "reseller" -> 180_000L          // interactive steps (wake lock 120s)
            else -> 180_000L
        }
    }

    /** Called (outside the lock) when a session hits its limit, so the app can
     * record it as an uncertain transaction. Must not throw. */
    @Volatile var onSessionTimeout: ((UssdQueueEntry) -> Unit)? = null

    /**
     * Waits until the PHONE itself is free before a granted session starts
     * dialing -- e.g. the owner is sending money by hand, has the dialer
     * open, or is on a call (PhoneBusyMonitor). The session keeps its turn
     * (every other request stays queued behind it) and calls `onWaiting`
     * with a reason ("a USSD session", ...) or null when free. Its time
     * limit only starts once this returns. Null = no such check (tests).
     */
    @Volatile var phoneFreeGate: (suspend (onWaiting: suspend (String?) -> Unit) -> Unit)? = null

    private val guard = Mutex()
    private val waiters = mutableListOf<Waiter>()
    private var running: Waiter? = null
    private var runningTicketId: Long = -1
    private var runningSinceMs: Long = 0
    private var watchdog: Job? = null
    private var coolingDown = false
    private var waitingForPhone: String? = null
    private val timedOut = ArrayDeque<UssdQueueEntry>()
    private val sequenceCounter = AtomicLong(0)
    private val ticketCounter = AtomicLong(0)
    private val watchdogScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _status = MutableStateFlow(UssdQueueStatus())

    /** Live Running/Waiting view of the queue, for the agent's screens. */
    val status: StateFlow<UssdQueueStatus> = _status.asStateFlow()

    /** Test-only: clears all state between test cases. */
    internal suspend fun resetForTest() {
        guard.withLock {
            watchdog?.cancel()
            watchdog = null
            waiters.clear()
            running = null
            runningTicketId = -1
            coolingDown = false
            waitingForPhone = null
            timedOut.clear()
            publishLocked()
        }
    }

    /** Suspends until [requestId] is at the head of the app-wide queue and
     * nothing else is running. [simSlot] is the SIM this request will dial
     * on (shown to the agent; it no longer gives a separate queue). */
    suspend fun acquire(simSlot: Int, requestId: String, arrivalTimeMs: Long): Ticket {
        val waiter = Waiter(requestId, simSlot, arrivalTimeMs, System.currentTimeMillis(), sequenceCounter.getAndIncrement(), CompletableDeferred())
        val iAmDebounceLeader = guard.withLock {
            waiters.add(waiter)
            waiters.sortWith(compareBy({ it.arrivalTimeMs }, { it.sequence }))
            publishLocked()
            running == null && waiters.size == 1
        }
        if (iAmDebounceLeader) {
            // NonCancellable: the promotion decision is shared state, not
            // this caller's own work -- it must always complete.
            withContext(NonCancellable) {
                delay(debounceMs)
                guard.withLock { promoteNextLocked() }
            }
        }
        try {
            val ticket = waiter.signal.await()
            val gate = phoneFreeGate
            if (gate != null) {
                // Our turn -- but the phone may be in use by its owner. Wait
                // (still holding the turn), then start the time limit.
                gate { reason ->
                    guard.withLock {
                        if (runningTicketId == ticket.id && waitingForPhone != reason) {
                            waitingForPhone = reason
                            publishLocked()
                        }
                    }
                }
                guard.withLock {
                    if (runningTicketId == ticket.id) {
                        waitingForPhone = null
                        runningSinceMs = System.currentTimeMillis()
                        watchdog?.cancel()
                        startWatchdogLocked(ticket)
                        publishLocked()
                    }
                }
            }
            return ticket
        } catch (e: Throwable) {
            withContext(NonCancellable) {
                guard.withLock {
                    if (!waiters.remove(waiter) && waiter.signal.isCompleted && running === waiter) {
                        // Granted the turn but cancelled before acting on it.
                        finishRunningLocked()
                    }
                    publishLocked()
                }
            }
            throw e
        }
    }

    /** Hands the session back and starts the next waiting request at once. */
    suspend fun release(ticket: Ticket) {
        guard.withLock {
            if (ticket.id != runningTicketId) {
                // Already force-released by the safety net (or released
                // twice): the queue has moved on, so nothing to do.
                return@withLock
            }
            finishRunningLocked()
        }
    }

    // ---- must be called while holding `guard` ----

    private fun finishRunningLocked() {
        watchdog?.cancel()
        watchdog = null
        running = null
        runningTicketId = -1
        waitingForPhone = null
        promoteNextLocked()
        publishLocked()
    }

    private fun promoteNextLocked() {
        if (running != null || coolingDown) return
        val head = waiters.removeFirstOrNull()
        if (head == null) {
            publishLocked()
            return
        }
        val ticket = Ticket(head.simSlot, head.requestId, ticketCounter.incrementAndGet())
        running = head
        runningTicketId = ticket.id
        runningSinceMs = System.currentTimeMillis()
        // With a phone-free check the limit starts after it (see acquire).
        if (phoneFreeGate == null) startWatchdogLocked(ticket)
        publishLocked()
        head.signal.complete(ticket)
    }

    private fun startWatchdogLocked(ticket: Ticket) {
        val limit = sessionLimitMs(ticket.requestId)
        watchdog = watchdogScope.launch {
            delay(limit)
            var entry: UssdQueueEntry? = null
            guard.withLock {
                if (runningTicketId != ticket.id) return@withLock
                DiagnosticsLog.record(
                    "ussd_queue_timeout",
                    "USSD session ${ticket.requestId} ran over ${limit / 1000}s -- outcome uncertain; not retried; next request starts after a short pause.",
                    isError = true,
                )
                entry = UssdQueueEntry(normalizeUssdJobKey(ticket.requestId), ussdJobLabel(ticket.requestId), ticket.simSlot, System.currentTimeMillis())
                timedOut.addFirst(entry!!)
                while (timedOut.size > 5) timedOut.removeLast()
                watchdog = null
                running = null
                runningTicketId = -1
                coolingDown = true
                publishLocked()
            }
            val e = entry ?: return@launch
            try { onSessionTimeout?.invoke(e) } catch (_: Throwable) { }
            delay(timeoutCooldownMs)
            guard.withLock {
                coolingDown = false
                promoteNextLocked()
                publishLocked()
            }
        }
    }

    private fun publishLocked() {
        val now = running
        _status.value = UssdQueueStatus(
            running = now?.let { UssdQueueEntry(normalizeUssdJobKey(it.requestId), ussdJobLabel(it.requestId), it.simSlot, runningSinceMs) },
            waiting = waiters.map { UssdQueueEntry(normalizeUssdJobKey(it.requestId), ussdJobLabel(it.requestId), it.simSlot, it.enqueuedAtMs) },
            timedOut = timedOut.toList(),
            runningLimitMs = now?.let { sessionLimitMs(it.requestId) } ?: 0L,
            phoneBusy = if (now != null) waitingForPhone else null,
        )
    }
}

/** One request in the queue, as the agent sees it. [key] is the job's
 * stable id, e.g. "internet_store:ORDER_ID" -- see [normalizeUssdJobKey]. */
data class UssdQueueEntry(val key: String, val label: String, val simSlot: Int, val sinceMs: Long)

/** Running request (at most one, app-wide) and the Waiting ones in order. */
data class UssdQueueStatus(
    val running: UssdQueueEntry? = null,
    val waiting: List<UssdQueueEntry> = emptyList(),
    /** Sessions that hit their time limit this run, newest first: outcome uncertain. */
    val timedOut: List<UssdQueueEntry> = emptyList(),
    /** The running session's hard limit, for "1:10 of 3:00". */
    val runningLimitMs: Long = 0L,
    /** Set while the next session waits because the phone is in use by
     * its owner (e.g. "a USSD session"); it hasn't dialed yet. */
    val phoneBusy: String? = null,
) {
    val isIdle: Boolean get() = running == null && waiting.isEmpty()

    /** Running / Waiting (with 1-based position) / not queued, for one job. */
    fun stateOf(key: String): UssdJobState {
        val k = normalizeUssdJobKey(key)
        if (running?.key == k) return UssdJobState.Running
        val i = waiting.indexOfFirst { it.key == k }
        if (i >= 0) return UssdJobState.Waiting(i + 1, waiting.size)
        return if (timedOut.any { it.key == k }) UssdJobState.TimedOut else UssdJobState.None
    }
}

sealed class UssdJobState {
    object None : UssdJobState()
    object Running : UssdJobState()
    data class Waiting(val position: Int, val total: Int) : UssdJobState()
    /** Hit its time limit: the carrier may or may not have done it. */
    object TimedOut : UssdJobState()
}

/** The stable job id behind a lock request id: drops the per-attempt
 * suffix (":attempt2") and gives both Reseller Withdraw paths one name. */
fun normalizeUssdJobKey(requestId: String): String {
    val noAttempt = requestId.replace(Regex(":attempt\\d+$"), "")
    return if (noAttempt.startsWith("reseller_withdrawal:")) "reseller:" + noAttempt.removePrefix("reseller_withdrawal:") else noAttempt
}

/** Short label shown to the agent, e.g. "Order 1234". */
fun ussdJobLabel(requestId: String): String {
    val key = normalizeUssdJobKey(requestId)
    val id = key.substringAfter(':', "")
    return when (key.substringBefore(':')) {
        "internet_store" -> "Order $id"
        "exchange" -> "Money Exchange $id"
        "wallet-lookup" -> "Wallet name lookup"
        "reseller" -> "Reseller withdrawal $id"
        else -> "USSD request"
    }
}

/**
 * The one app-wide record of which payment/transaction jobs are being
 * processed right now. Every flow's own in-flight guard (UssdOrchestrator's
 * claimOrder, ExchangeUssdOrchestrator's / WalletLookupUssdOrchestrator's /
 * both Reseller Withdraw orchestrators' claim) uses this, under the job's
 * normalized key -- so the same job can never be started twice, from any
 * screen or background sweep, and the two Reseller Withdraw paths now also
 * guard against EACH OTHER for the same withdrawal.
 */
object UssdJobRegistry {
    private val mutex = Mutex()
    private val active = mutableSetOf<String>()
    private val _activeKeys = MutableStateFlow<Set<String>>(emptySet())

    /** Jobs in progress right now (for the screens; never used to decide). */
    val activeKeys: StateFlow<Set<String>> = _activeKeys.asStateFlow()

    /** True if this caller now owns [key]; false if it is already in progress. */
    suspend fun claim(key: String): Boolean = mutex.withLock {
        active.add(normalizeUssdJobKey(key)).also { _activeKeys.value = active.toSet() }
    }

    suspend fun release(key: String) {
        mutex.withLock {
            active.remove(normalizeUssdJobKey(key))
            _activeKeys.value = active.toSet()
        }
    }

    internal suspend fun isActive(key: String): Boolean = mutex.withLock { normalizeUssdJobKey(key) in active }

    internal suspend fun resetForTest() {
        mutex.withLock {
            active.clear()
            _activeKeys.value = emptySet()
        }
    }
}
