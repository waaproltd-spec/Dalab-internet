package com.dalab.internet.ussd

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicLong

/**
 * Cross-flow FIFO queue enforcing "one interactive USSD session at a time"
 * between eBadal (Money Exchange) and Reseller Withdraw — the two flows
 * that drive the same phone/SIM through the same on-screen
 * AccessibilityService "USSD message" reply dialog (see
 * ExchangeUssdAccessibilityService /
 * ResellerWithdrawalInteractiveUssdAccessibilityService). Android delivers
 * onAccessibilityEvent to every enabled AccessibilityService at once, so
 * without this, both services could independently read/act on whatever
 * dialog happens to be on screen if their flows ever overlapped.
 *
 * Internet Store (UssdDialer/UssdOrchestrator) never touches this queue at
 * all: it drives TelephonyManager.sendUssdRequest() directly with no
 * visible dialog and no AccessibilityService involvement, so it cannot
 * collide with either interactive flow the way they can collide with each
 * other, and stays exactly as fast/independent as before.
 *
 * Ordering is by each request's own real backend creation timestamp
 * (`arrivalTimeMs` — e.g. ExchangeOrder.createdAt /
 * ResellerWithdrawalPendingPayout.createdAt), NOT the moment this device
 * happens to notice or dial it, with a monotonic per-process `sequence` as
 * a pure tie-breaker for two requests sharing the same millisecond. A
 * plain Mutex only orders callers by when they happen to call
 * lock()/withLock() — eBadal and Reseller are each discovered by their own
 * independent polling loop (see AgentBackgroundService's
 * exchangeSelfHealSweepLoop/resellerWithdrawalSelfHealSweepLoop) and could
 * otherwise call in at slightly different moments than their true creation
 * order, which is why this queue exists instead of a bare Mutex.
 *
 * [debounceMs] exists only to correctly order two requests that arrive "at
 * nearly the same time" against a fully idle queue (nothing else active or
 * waiting): the very first request to reach an idle queue holds off
 * briefly to give a near-simultaneous sibling from the other service a
 * chance to enqueue too, then whichever of them actually has the earlier
 * arrivalTimeMs is promoted. Once any request is already queued (whether
 * because a session is actively running, or a debounce window is already
 * in progress for this idle transition), every later arrival simply joins
 * the existing sorted queue with no further delay, and [release] promotes
 * the next request immediately (no debounce) — the multi-second USSD
 * session that was already running is itself the "grace window" for those
 * arrivals, so "the next queued operation should start automatically" is
 * never held up by this.
 */
object InteractiveUssdSessionQueue {

    /** Held by whichever request currently owns the shared USSD session.
     * Must always be handed back to [release] exactly once — on SUCCESS,
     * FAILED, CANCELLED, TIMEOUT, or any unexpected exception — via a
     * try/finally around the dial, same pattern already used for the wake
     * lock and the bridge's arm()/disarm() in both orchestrators. */
    class Ticket internal constructor(internal val requestId: String)

    private data class Waiter(
        val requestId: String,
        val arrivalTimeMs: Long,
        val sequence: Long,
        val signal: CompletableDeferred<Ticket>,
    )

    /** Real production value; shrunk by tests so they don't have to wait
     * out a real 300ms — see InteractiveUssdSessionQueueTest. */
    internal var debounceMs: Long = 300L

    private val guard = Mutex()
    private val waiters = mutableListOf<Waiter>()
    private val sequenceCounter = AtomicLong(0)
    private var busy = false

    /** Test-only: clears all state between test cases — this object is a
     * process-wide singleton and would otherwise leak state across test
     * cases run in the same JVM. */
    internal suspend fun resetForTest() {
        guard.withLock {
            waiters.clear()
            busy = false
        }
    }

    /** Suspends until [requestId] reaches the head of the shared queue —
     * see the class doc for exactly how "head" is decided. Returns a
     * [Ticket] that MUST be passed to [release] exactly once, however this
     * request's own session ends up finishing. */
    suspend fun acquire(requestId: String, arrivalTimeMs: Long): Ticket {
        val waiter = Waiter(requestId, arrivalTimeMs, sequenceCounter.getAndIncrement(), CompletableDeferred())
        val iAmDebounceLeader = guard.withLock {
            waiters.add(waiter)
            waiters.sortWith(compareBy({ it.arrivalTimeMs }, { it.sequence }))
            // Only the very first arrival to a fully idle queue leads the
            // debounce -- everyone else (whether a session is already
            // running, or a debounce is already in flight for this same
            // idle transition) just joins the sorted list above and waits
            // for that leader's promotion pass to consider them too.
            !busy && waiters.size == 1
        }
        if (iAmDebounceLeader) {
            // NonCancellable: this caller's own coroutine could be
            // cancelled mid-debounce (e.g. the flow it belongs to was
            // torn down) -- the promotion decision is shared, process-wide
            // state, not this caller's own work, so it must always run to
            // completion or every later-queued request would stall behind
            // a debounce that never resolves.
            withContext(NonCancellable) {
                delay(debounceMs)
                guard.withLock { promoteNextLocked() }
            }
        }
        try {
            return waiter.signal.await()
        } catch (e: Throwable) {
            withContext(NonCancellable) {
                guard.withLock {
                    if (!waiters.remove(waiter) && waiter.signal.isCompleted && busy) {
                        // Was granted the turn but this caller is being
                        // cancelled/failed before it could act on it --
                        // release immediately so the queue keeps moving
                        // instead of stalling forever.
                        busy = false
                        promoteNextLocked()
                    }
                }
            }
            throw e
        }
    }

    /** Hands the shared session back. Always promotes the next-earliest
     * queued request (if any) immediately — no debounce, see class doc. */
    suspend fun release(ticket: Ticket) {
        guard.withLock {
            busy = false
            promoteNextLocked()
        }
    }

    // Must be called while already holding `guard`.
    private fun promoteNextLocked() {
        if (busy) return
        val head = waiters.removeFirstOrNull() ?: return
        busy = true
        head.signal.complete(Ticket(head.requestId))
    }
}
