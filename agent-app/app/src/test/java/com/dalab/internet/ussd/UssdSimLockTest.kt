package com.dalab.internet.ussd

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.supervisorScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * Regression coverage for the shared per-SIM-slot USSD lock — see
 * UssdSimLock's own doc comment for why a bare Mutex isn't enough (it only
 * orders callers by call time, not by the requests' real creation time),
 * and for why this is keyed per SIM slot rather than being one lock for the
 * whole device. These tests exercise the real Mutex/CompletableDeferred
 * concurrency directly with `runBlocking`, no fakes — [UssdSimLock.debounceMs]
 * is shrunk in [setUp] so the tests run fast without weakening what's
 * actually being proven.
 */
class UssdSimLockTest {

    @Before
    fun setUp() = runBlocking {
        UssdSimLock.debounceMs = 20L
        UssdSimLock.resetForTest()
    }

    /** Simulates one flow's full USSD session on [simSlot]: acquire -> hold
     * the ticket for [holdMs] while bumping [activeCount] (so a
     * concurrency violation on that SAME slot would show activeCount > 1)
     * -> release. Returns the requestId that actually ran, in the order it
     * ran, via [order]. */
    private fun CoroutineScope.session(
        simSlot: Int,
        requestId: String,
        arrivalTimeMs: Long,
        holdMs: Long,
        activeCount: AtomicInteger,
        maxObservedActive: AtomicInteger,
        order: MutableList<String>,
        failWith: Throwable? = null,
    ): Deferred<Unit> = async {
        val ticket = UssdSimLock.acquire(simSlot, requestId, arrivalTimeMs)
        try {
            synchronized(order) { order.add(requestId) }
            val now = activeCount.incrementAndGet()
            maxObservedActive.updateAndGet { maxOf(it, now) }
            delay(holdMs)
            if (failWith != null) throw failWith
        } finally {
            activeCount.decrementAndGet()
            UssdSimLock.release(ticket)
        }
    }

    @Test
    fun `two requests for the SAME SIM slot arriving together never run at the same time`() = runBlocking {
        val activeCount = AtomicInteger(0)
        val maxObservedActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        val a = session(1, "exchange:DEX1", arrivalTimeMs = 1_000L, holdMs = 40L, activeCount, maxObservedActive, order)
        val b = session(1, "reseller:WDR1", arrivalTimeMs = 1_001L, holdMs = 40L, activeCount, maxObservedActive, order)
        a.await()
        b.await()

        assertEquals("both requests should have actually run", 2, order.size)
        assertEquals(1, maxObservedActive.get())
    }

    @Test
    fun `requests for DIFFERENT SIM slots run fully concurrently -- neither waits on the other`() = runBlocking {
        val activeCountSim1 = AtomicInteger(0)
        val activeCountSim2 = AtomicInteger(0)
        val maxObservedSim1 = AtomicInteger(0)
        val maxObservedSim2 = AtomicInteger(0)
        val order = mutableListOf<String>()
        val bothActiveAtOnce = AtomicInteger(0)

        // A long session on SIM 1 must never delay a session on SIM 2, and
        // vice versa -- this is the actual behavior the fix requires ("If
        // an Agent has 2 mobile phones and 4 SIMs, routing must correctly
        // isolate each Mobile/SIM... only one USSD session at a time per
        // SIM", never a device-wide serialization).
        val sim1 = async {
            val ticket = UssdSimLock.acquire(1, "reseller_withdrawal:WDR1", arrivalTimeMs = 1_000L)
            try {
                synchronized(order) { order.add("sim1-start") }
                activeCountSim1.incrementAndGet()
                if (activeCountSim2.get() > 0) bothActiveAtOnce.incrementAndGet()
                delay(60L)
            } finally {
                activeCountSim1.decrementAndGet()
                UssdSimLock.release(ticket)
            }
        }
        delay(10L) // let sim1 clearly start first
        val sim2 = async {
            val ticket = UssdSimLock.acquire(2, "exchange:DEX1", arrivalTimeMs = 1_010L)
            try {
                synchronized(order) { order.add("sim2-start") }
                activeCountSim2.incrementAndGet()
                if (activeCountSim1.get() > 0) bothActiveAtOnce.incrementAndGet()
                delay(10L)
            } finally {
                activeCountSim2.decrementAndGet()
                UssdSimLock.release(ticket)
            }
        }
        sim1.await()
        sim2.await()

        assertTrue(
            "SIM 2's request must be able to start and finish WHILE SIM 1's own session is still running",
            bothActiveAtOnce.get() > 0,
        )
        assertEquals(listOf("sim1-start", "sim2-start"), order)
    }

    @Test
    fun `FIFO order within one SIM slot follows real arrival timestamp, not which flow happened to call in first`() = runBlocking {
        val activeCount = AtomicInteger(0)
        val maxObservedActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        // Reseller "calls in" to acquire() before eBadal in wall-clock
        // terms, but eBadal's request was actually created earlier
        // (smaller arrivalTimeMs) -- both land inside the debounce window
        // for a cold slot-queue, so eBadal must still go first.
        val reseller = session(1, "reseller:WDR1", arrivalTimeMs = 2_000L, holdMs = 30L, activeCount, maxObservedActive, order)
        delay(5L)
        val exchange = session(1, "exchange:DEX1", arrivalTimeMs = 1_000L, holdMs = 30L, activeCount, maxObservedActive, order)
        reseller.await()
        exchange.await()

        assertEquals(listOf("exchange:DEX1", "reseller:WDR1"), order)
        assertEquals(1, maxObservedActive.get())
    }

    @Test
    fun `two requests for the same slot can never simultaneously hold that slot's session`() = runBlocking {
        val activeCount = AtomicInteger(0)
        val maxObservedActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        val jobs = (1..6).map { i ->
            val fromExchange = i % 2 == 0
            session(
                simSlot = 1,
                requestId = if (fromExchange) "exchange:DEX$i" else "reseller:WDR$i",
                arrivalTimeMs = 1_000L + i,
                holdMs = 15L,
                activeCount = activeCount,
                maxObservedActive = maxObservedActive,
                order = order,
            )
        }
        jobs.forEach { it.await() }

        assertEquals(6, order.size)
        assertEquals("at most one session must ever be active on this slot at once", 1, maxObservedActive.get())
    }

    // These two tests deliberately throw inside a session -- plain `async`
    // under runBlocking's own (non-supervisor) scope would otherwise
    // propagate that exception and cancel every sibling coroutine the
    // moment it occurs, which would make "the other request still finishes"
    // untestable for the wrong reason. supervisorScope isolates each
    // session's failure to itself, matching how a real failed/timed-out
    // dial must never take down anything else in the process.
    @Test
    fun `a timeout (exception) releases the slot's lock so the next request starts`() = runBlocking {
        supervisorScope {
            val activeCount = AtomicInteger(0)
            val maxObservedActive = AtomicInteger(0)
            val order = mutableListOf<String>()

            val timedOut = session(
                1, "exchange:DEX_TIMEOUT", arrivalTimeMs = 1_000L, holdMs = 10L, activeCount, maxObservedActive, order,
                failWith = RuntimeException("simulated carrier timeout"),
            )
            val next = session(1, "reseller:WDR_NEXT", arrivalTimeMs = 1_050L, holdMs = 10L, activeCount, maxObservedActive, order)

            var caught: Throwable? = null
            try {
                timedOut.await()
            } catch (e: Throwable) {
                caught = e
            }
            next.await()

            assertTrue("the failing session's own exception must propagate to its own caller", caught != null)
            assertEquals(listOf("exchange:DEX_TIMEOUT", "reseller:WDR_NEXT"), order)
            assertEquals(1, maxObservedActive.get())
        }
    }

    @Test
    fun `a failed request does not block requests queued behind it on the same slot`() = runBlocking {
        supervisorScope {
            val activeCount = AtomicInteger(0)
            val maxObservedActive = AtomicInteger(0)
            val order = mutableListOf<String>()

            val failing = session(
                1, "reseller:WDR_FAIL", arrivalTimeMs = 1_000L, holdMs = 10L, activeCount, maxObservedActive, order,
                failWith = IllegalStateException("simulated failed payout"),
            )
            val queuedDuringFailure = session(1, "exchange:DEX_AFTER", arrivalTimeMs = 1_020L, holdMs = 10L, activeCount, maxObservedActive, order)
            val queuedLater = session(1, "reseller:WDR_AFTER", arrivalTimeMs = 1_040L, holdMs = 10L, activeCount, maxObservedActive, order)

            runCatching { failing.await() }
            queuedDuringFailure.await()
            queuedLater.await()

            assertEquals(listOf("reseller:WDR_FAIL", "exchange:DEX_AFTER", "reseller:WDR_AFTER"), order)
        }
    }

    @Test
    fun `each ticket carries only its own slot and requestId -- no cross-assignment between concurrent requests`() = runBlocking {
        val ticketA = UssdSimLock.acquire(1, "exchange:DEX_OWN", arrivalTimeMs = 1_000L)
        assertEquals("exchange:DEX_OWN", ticketA.requestId)
        assertEquals(1, ticketA.simSlot)
        UssdSimLock.release(ticketA)

        val ticketB = UssdSimLock.acquire(2, "reseller:WDR_OWN", arrivalTimeMs = 1_001L)
        assertEquals("reseller:WDR_OWN", ticketB.requestId)
        assertEquals(2, ticketB.simSlot)
        UssdSimLock.release(ticketB)
    }

    @Test
    fun `requests arriving while a session is active on that slot are queued and start automatically once it finishes`() = runBlocking {
        val activeCount = AtomicInteger(0)
        val maxObservedActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        val active = session(1, "exchange:DEX_ACTIVE", arrivalTimeMs = 1_000L, holdMs = 60L, activeCount, maxObservedActive, order)
        // Arrives well after the debounce window has already resolved
        // against the active session, and well before it finishes -- must
        // be queued, not dropped, and must start with no manual restart.
        delay(30L)
        val queued = session(1, "reseller:WDR_QUEUED", arrivalTimeMs = 1_030L, holdMs = 10L, activeCount, maxObservedActive, order)

        active.await()
        queued.await()

        assertEquals(listOf("exchange:DEX_ACTIVE", "reseller:WDR_QUEUED"), order)
        assertEquals(1, maxObservedActive.get())
    }
}
