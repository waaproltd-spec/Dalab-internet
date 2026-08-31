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
 * Regression coverage for the shared eBadal/Reseller Withdraw USSD session
 * queue — see InteractiveUssdSessionQueue's own doc comment for why a bare
 * Mutex isn't enough on its own (it only orders callers by call time, not
 * by the requests' real creation time). These tests exercise the real
 * Mutex/CompletableDeferred concurrency directly with `runBlocking`, no
 * fakes — [InteractiveUssdSessionQueue.debounceMs] is shrunk in [setUp] so
 * the tests run fast without weakening what's actually being proven.
 */
class InteractiveUssdSessionQueueTest {

    @Before
    fun setUp() = runBlocking {
        InteractiveUssdSessionQueue.debounceMs = 20L
        InteractiveUssdSessionQueue.resetForTest()
    }

    /** Simulates one flow's full USSD session: acquire -> hold the ticket
     * for [holdMs] while bumping [activeCount] (so a concurrency violation
     * would show activeCount > 1) -> release. Returns the requestId that
     * actually ran, in the order it ran, via [order]. */
    private fun CoroutineScope.session(
        requestId: String,
        arrivalTimeMs: Long,
        holdMs: Long,
        activeCount: AtomicInteger,
        maxObservedActive: AtomicInteger,
        order: MutableList<String>,
        failWith: Throwable? = null,
    ): Deferred<Unit> = async {
        val ticket = InteractiveUssdSessionQueue.acquire(requestId, arrivalTimeMs)
        try {
            synchronized(order) { order.add(requestId) }
            val now = activeCount.incrementAndGet()
            maxObservedActive.updateAndGet { maxOf(it, now) }
            delay(holdMs)
            if (failWith != null) throw failWith
        } finally {
            activeCount.decrementAndGet()
            InteractiveUssdSessionQueue.release(ticket)
        }
    }

    @Test
    fun `eBadal and Reseller arriving together never run at the same time`() = runBlocking {
        val activeCount = AtomicInteger(0)
        val maxObservedActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        val a = session("exchange:DEX1", arrivalTimeMs = 1_000L, holdMs = 40L, activeCount, maxObservedActive, order)
        val b = session("reseller:WDR1", arrivalTimeMs = 1_001L, holdMs = 40L, activeCount, maxObservedActive, order)
        a.await()
        b.await()

        assertEquals("both requests should have actually run", 2, order.size)
        assertEquals(1, maxObservedActive.get())
    }

    @Test
    fun `FIFO order follows real arrival timestamp, not which flow happened to call in first`() = runBlocking {
        val activeCount = AtomicInteger(0)
        val maxObservedActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        // Reseller "calls in" to acquire() before eBadal in wall-clock
        // terms, but eBadal's request was actually created earlier
        // (smaller arrivalTimeMs) -- both land inside the debounce window
        // for a cold queue, so eBadal must still go first.
        val reseller = session("reseller:WDR1", arrivalTimeMs = 2_000L, holdMs = 30L, activeCount, maxObservedActive, order)
        delay(5L)
        val exchange = session("exchange:DEX1", arrivalTimeMs = 1_000L, holdMs = 30L, activeCount, maxObservedActive, order)
        reseller.await()
        exchange.await()

        assertEquals(listOf("exchange:DEX1", "reseller:WDR1"), order)
        assertEquals(1, maxObservedActive.get())
    }

    @Test
    fun `two requests can never simultaneously hold the shared session`() = runBlocking {
        val activeCount = AtomicInteger(0)
        val maxObservedActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        val jobs = (1..6).map { i ->
            val fromExchange = i % 2 == 0
            session(
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
        assertEquals("at most one session must ever be active at once", 1, maxObservedActive.get())
    }

    // These two tests deliberately throw inside a session -- plain `async`
    // under runBlocking's own (non-supervisor) scope would otherwise
    // propagate that exception and cancel every sibling coroutine the
    // moment it occurs, which would make "the other request still finishes"
    // untestable for the wrong reason. supervisorScope isolates each
    // session's failure to itself, matching how a real failed/timed-out
    // dial must never take down anything else in the process.
    @Test
    fun `a timeout (exception) releases the lock so the next request starts`() = runBlocking {
        supervisorScope {
            val activeCount = AtomicInteger(0)
            val maxObservedActive = AtomicInteger(0)
            val order = mutableListOf<String>()

            val timedOut = session(
                "exchange:DEX_TIMEOUT", arrivalTimeMs = 1_000L, holdMs = 10L, activeCount, maxObservedActive, order,
                failWith = RuntimeException("simulated carrier timeout"),
            )
            val next = session("reseller:WDR_NEXT", arrivalTimeMs = 1_050L, holdMs = 10L, activeCount, maxObservedActive, order)

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
    fun `a failed request does not block requests queued behind it`() = runBlocking {
        supervisorScope {
            val activeCount = AtomicInteger(0)
            val maxObservedActive = AtomicInteger(0)
            val order = mutableListOf<String>()

            val failing = session(
                "reseller:WDR_FAIL", arrivalTimeMs = 1_000L, holdMs = 10L, activeCount, maxObservedActive, order,
                failWith = IllegalStateException("simulated failed payout"),
            )
            val queuedDuringFailure = session("exchange:DEX_AFTER", arrivalTimeMs = 1_020L, holdMs = 10L, activeCount, maxObservedActive, order)
            val queuedLater = session("reseller:WDR_AFTER", arrivalTimeMs = 1_040L, holdMs = 10L, activeCount, maxObservedActive, order)

            runCatching { failing.await() }
            queuedDuringFailure.await()
            queuedLater.await()

            assertEquals(listOf("reseller:WDR_FAIL", "exchange:DEX_AFTER", "reseller:WDR_AFTER"), order)
        }
    }

    @Test
    fun `each ticket carries only its own requestId -- no cross-assignment between concurrent requests`() = runBlocking {
        val ticketA = InteractiveUssdSessionQueue.acquire("exchange:DEX_OWN", arrivalTimeMs = 1_000L)
        assertEquals("exchange:DEX_OWN", ticketA.requestId)
        InteractiveUssdSessionQueue.release(ticketA)

        val ticketB = InteractiveUssdSessionQueue.acquire("reseller:WDR_OWN", arrivalTimeMs = 1_001L)
        assertEquals("reseller:WDR_OWN", ticketB.requestId)
        InteractiveUssdSessionQueue.release(ticketB)
    }

    @Test
    fun `requests arriving while a session is active are queued and start automatically once it finishes`() = runBlocking {
        val activeCount = AtomicInteger(0)
        val maxObservedActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        val active = session("exchange:DEX_ACTIVE", arrivalTimeMs = 1_000L, holdMs = 60L, activeCount, maxObservedActive, order)
        // Arrives well after the debounce window has already resolved
        // against the active session, and well before it finishes -- must
        // be queued, not dropped, and must start with no manual restart.
        delay(30L)
        val queued = session("reseller:WDR_QUEUED", arrivalTimeMs = 1_030L, holdMs = 10L, activeCount, maxObservedActive, order)

        active.await()
        queued.await()

        assertEquals(listOf("exchange:DEX_ACTIVE", "reseller:WDR_QUEUED"), order)
        assertEquals(1, maxObservedActive.get())
    }
}
