package com.dalab.internet.ussd

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicLong

/**
 * Cross-flow FIFO lock enforcing "one USSD session at a time per physical
 * SIM slot" — across EVERY flow that can dial a USSD code on this device:
 * Internet Store recharge (UssdOrchestrator), Money Exchange payout
 * (ExchangeUssdOrchestrator) and its own Wallet Name Lookup
 * (WalletLookupUssdOrchestrator), and Reseller Withdraw (both its one-shot
 * UssdOrchestrator-style path and its interactive
 * ResellerWithdrawalInteractiveUssdOrchestrator path). Every one of those
 * ultimately drives the same physical modem/SIM radio, whether via
 * TelephonyManager.sendUssdRequest() (no visible dialog) or ACTION_CALL +
 * the on-screen "USSD message" reply dialog (read by an AccessibilityService)
 * — two overlapping sessions on the SAME SIM is a real hazard regardless of
 * which mechanism either side uses (the carrier/modem serializes USSD
 * sessions per SIM itself; dialing a second one mid-session can abort the
 * first, return a garbled/cross-contaminated response, or simply fail), and
 * two DIFFERENT SIMs are two independent physical radios that never need to
 * wait on each other at all.
 *
 * This was formerly InteractiveUssdSessionQueue, a single GLOBAL queue
 * (deliberately covering only the two AccessibilityService-driven flows,
 * since those were the only ones that could visibly collide with each
 * OTHER on screen). Two gaps that left real overlap possible: (1) it never
 * serialized against the one-shot TelephonyManager-based flows at all — an
 * Internet Store recharge and a Money Exchange payout could genuinely dial
 * the same physical SIM at the same moment; (2) it was one shared queue for
 * the whole device, not per SIM slot — a 2-SIM device serialized SIM 1 and
 * SIM 2 against each other unnecessarily, even though they're independent
 * radios. Generalized here to key every bit of this state (the waiter
 * list, the debounce leader, the busy flag) by [Int] SIM slot (1 or 2):
 * each slot gets its own fully independent FIFO queue, and every dialing
 * flow — one-shot or interactive — now acquires the lock for the SIM slot
 * it's about to dial on, for exactly the span of that one dial attempt.
 *
 * Ordering within one SIM slot's queue is by each request's own real
 * arrival time (business creation timestamp where the caller has one —
 * e.g. ExchangeOrder.createdAt / ResellerWithdrawalPendingPayout.createdAt
 * — or simply "now" for the one-shot flows below, which have no equivalent
 * cross-flow-discovery-race to solve — see each call site), NOT the moment
 * this device happens to notice or dial it, with a monotonic per-process
 * `sequence` as a pure tie-breaker for two requests sharing the same
 * millisecond. A plain Mutex only orders callers by when they happen to
 * call lock()/withLock() — eBadal and Reseller are each discovered by their
 * own independent polling loop (see AgentBackgroundService's various
 * *SelfHealSweepLoop functions) and could otherwise call in at slightly
 * different moments than their true creation order, which is why this
 * exists instead of a bare per-slot Mutex.
 *
 * [debounceMs] exists only to correctly order two requests for the SAME SIM
 * slot that arrive "at nearly the same time" against a fully idle queue for
 * that slot (nothing else active or waiting on it): the very first request
 * to reach an idle slot-queue holds off briefly to give a near-simultaneous
 * sibling a chance to enqueue too, then whichever of them actually has the
 * earlier arrivalTimeMs is promoted. Once any request is already queued for
 * that slot (whether because a session is actively running on it, or a
 * debounce window is already in progress for this idle transition), every
 * later arrival for that same slot simply joins the existing sorted queue
 * with no further delay, and [release] promotes that slot's next request
 * immediately (no debounce) — the multi-second USSD session that was
 * already running is itself the "grace window" for those arrivals, so "the
 * next queued operation should start automatically" is never held up by
 * this. A different SIM slot's own debounce/queue is entirely unaffected.
 */
object UssdSimLock {

    /** Held by whichever request currently owns [simSlot]'s shared USSD
     * session. Must always be handed back to [release] exactly once — on
     * SUCCESS, FAILED, CANCELLED, TIMEOUT, or any unexpected exception —
     * via a try/finally around the dial, same pattern already used for the
     * wake lock and the accessibility bridge's arm()/disarm() in every
     * interactive orchestrator. */
    class Ticket internal constructor(internal val simSlot: Int, internal val requestId: String)

    private data class Waiter(
        val requestId: String,
        val arrivalTimeMs: Long,
        val sequence: Long,
        val signal: CompletableDeferred<Ticket>,
    )

    /** Per-SIM-slot state — every field here is scoped to exactly one slot,
     * so slot 1 and slot 2 (or a future slot 3/4, if this device model ever
     * exposes more) are entirely independent queues. */
    private class SlotState {
        val waiters = mutableListOf<Waiter>()
        var busy = false
    }

    /** Real production value; shrunk by tests so they don't have to wait
     * out a real 300ms — see UssdSimLockTest. */
    internal var debounceMs: Long = 300L

    // One shared guard protects the whole `slots` map and every SlotState's
    // mutable fields — safe and cheap even under cross-slot contention
    // since every critical section here is a tiny in-memory list
    // operation, never held across the actual (multi-second) USSD dial
    // itself, which happens entirely between acquire() returning and
    // release() being called. Two different SIM slots' dials genuinely run
    // concurrently; this guard is only ever held for microseconds of
    // bookkeeping around that.
    private val guard = Mutex()
    private val slots = mutableMapOf<Int, SlotState>()

    // A single global monotonic counter, not one per slot: AtomicLong's own
    // getAndIncrement() is safe to call without `guard` (unlike the `slots`
    // map itself), and correctness only requires sequence values to be
    // unique and monotonic WITHIN one slot's own sorted waiter list --
    // never compared across slots -- so one shared counter for the whole
    // object is simplest and exactly as correct as a per-slot one would be.
    private val sequenceCounter = AtomicLong(0)

    private fun slotState(simSlot: Int): SlotState = slots.getOrPut(simSlot) { SlotState() }

    /** Test-only: clears all state between test cases — this object is a
     * process-wide singleton and would otherwise leak state across test
     * cases run in the same JVM. */
    internal suspend fun resetForTest() {
        guard.withLock { slots.clear() }
    }

    /** Suspends until [requestId] reaches the head of [simSlot]'s own
     * queue — see the class doc for exactly how "head" is decided. Returns
     * a [Ticket] that MUST be passed to [release] exactly once, however
     * this request's own session ends up finishing. */
    suspend fun acquire(simSlot: Int, requestId: String, arrivalTimeMs: Long): Ticket {
        val waiter = Waiter(requestId, arrivalTimeMs, sequenceCounter.getAndIncrement(), CompletableDeferred())
        val iAmDebounceLeader = guard.withLock {
            val state = slotState(simSlot)
            state.waiters.add(waiter)
            state.waiters.sortWith(compareBy({ it.arrivalTimeMs }, { it.sequence }))
            !state.busy && state.waiters.size == 1
        }
        if (iAmDebounceLeader) {
            // NonCancellable: this caller's own coroutine could be
            // cancelled mid-debounce (e.g. the flow it belongs to was torn
            // down) -- the promotion decision is shared, per-slot process-
            // wide state, not this caller's own work, so it must always run
            // to completion or every later-queued request for this slot
            // would stall behind a debounce that never resolves.
            withContext(NonCancellable) {
                delay(debounceMs)
                guard.withLock { promoteNextLocked(simSlot) }
            }
        }
        try {
            return waiter.signal.await()
        } catch (e: Throwable) {
            withContext(NonCancellable) {
                guard.withLock {
                    val state = slotState(simSlot)
                    if (!state.waiters.remove(waiter) && waiter.signal.isCompleted && state.busy) {
                        // Was granted the turn but this caller is being
                        // cancelled/failed before it could act on it --
                        // release immediately so this slot's queue keeps
                        // moving instead of stalling forever.
                        state.busy = false
                        promoteNextLocked(simSlot)
                    }
                }
            }
            throw e
        }
    }

    /** Hands [simSlot]'s shared session back. Always promotes that slot's
     * next-earliest queued request (if any) immediately — no debounce, see
     * class doc. Never affects any other SIM slot's own queue. */
    suspend fun release(ticket: Ticket) {
        guard.withLock {
            val state = slotState(ticket.simSlot)
            state.busy = false
            promoteNextLocked(ticket.simSlot)
        }
    }

    // Must be called while already holding `guard`.
    private fun promoteNextLocked(simSlot: Int) {
        val state = slotState(simSlot)
        if (state.busy) return
        val head = state.waiters.removeFirstOrNull() ?: return
        state.busy = true
        head.signal.complete(Ticket(simSlot, head.requestId))
    }
}
