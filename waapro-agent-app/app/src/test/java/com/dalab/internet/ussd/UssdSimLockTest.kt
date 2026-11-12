package com.dalab.internet.ussd

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * Regression coverage for the app-wide USSD queue (UssdSimLock): only ONE
 * USSD session at a time across the whole app, whatever the SIM slot, in
 * real arrival order -- see UssdSimLock's own doc comment. These tests exercise the real Mutex/CompletableDeferred
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
    fun `requests for DIFFERENT SIM slots never run at the same time -- one USSD session app-wide`() = runBlocking {
        val activeCount = AtomicInteger(0)
        val maxObservedActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        // The global rule: SIM 1 and SIM 2 share ONE queue. SIM 2's request
        // must wait for SIM 1's whole session, then start by itself.
        val sim1 = session(1, "reseller_withdrawal:WDR1", arrivalTimeMs = 1_000L, holdMs = 60L, activeCount, maxObservedActive, order)
        delay(10L)
        val sim2 = session(2, "exchange:DEX1", arrivalTimeMs = 1_010L, holdMs = 10L, activeCount, maxObservedActive, order)
        sim1.await()
        sim2.await()

        assertEquals("never two USSD sessions at once, even on different SIMs", 1, maxObservedActive.get())
        assertEquals(listOf("reseller_withdrawal:WDR1", "exchange:DEX1"), order)
    }

    @Test
    fun `four flows on four different SIM slots all run one at a time in arrival order`() = runBlocking {
        val activeCount = AtomicInteger(0)
        val maxObservedActive = AtomicInteger(0)
        val order = mutableListOf<String>()
        val jobs = listOf(
            session(2, "wallet-lookup:L1", arrivalTimeMs = 1_003L, holdMs = 15L, activeCount, maxObservedActive, order),
            session(1, "internet_store:O1:attempt1", arrivalTimeMs = 1_000L, holdMs = 15L, activeCount, maxObservedActive, order),
            session(3, "exchange:DEX9", arrivalTimeMs = 1_002L, holdMs = 15L, activeCount, maxObservedActive, order),
            session(4, "reseller:WDR9", arrivalTimeMs = 1_001L, holdMs = 15L, activeCount, maxObservedActive, order),
        )
        jobs.forEach { it.await() }
        assertEquals(1, maxObservedActive.get())
        assertEquals(listOf("internet_store:O1:attempt1", "reseller:WDR9", "exchange:DEX9", "wallet-lookup:L1"), order)
    }

    @Test
    fun `status shows the one Running request and the Waiting ones in order, then goes idle`() = runBlocking {
        assertTrue(UssdSimLock.status.value.isIdle)
        val first = UssdSimLock.acquire(1, "internet_store:ORD1:attempt1", arrivalTimeMs = 1_000L)
        val second = async { UssdSimLock.acquire(2, "exchange:DEX2", arrivalTimeMs = 1_001L) }
        val third = async { UssdSimLock.acquire(1, "reseller_withdrawal:WDR3:attempt1", arrivalTimeMs = 1_002L) }
        delay(40L)

        val s = UssdSimLock.status.value
        assertEquals("internet_store:ORD1", s.running?.key)
        assertEquals("Order ORD1", s.running?.label)
        assertEquals(1, s.running?.simSlot)
        assertEquals(listOf("exchange:DEX2", "reseller:WDR3"), s.waiting.map { it.key })
        assertEquals(UssdJobState.Running, s.stateOf("internet_store:ORD1"))
        assertEquals(UssdJobState.Waiting(1, 2), s.stateOf("exchange:DEX2"))
        assertEquals(UssdJobState.Waiting(2, 2), s.stateOf("reseller:WDR3"))
        assertEquals(UssdJobState.None, s.stateOf("internet_store:OTHER"))

        UssdSimLock.release(first)
        val t2 = second.await()
        assertEquals("exchange:DEX2", UssdSimLock.status.value.running?.key)
        UssdSimLock.release(t2)
        val t3 = third.await()
        assertEquals("reseller:WDR3", UssdSimLock.status.value.running?.key)
        UssdSimLock.release(t3)
        assertTrue(UssdSimLock.status.value.isIdle)
    }

    @Test
    fun `a session stuck past the safety limit is released so the queue keeps moving, and its late release is ignored`() = runBlocking {
        UssdSimLock.maxSessionMs = 60L
        try {
            val stuck = UssdSimLock.acquire(1, "exchange:STUCK", arrivalTimeMs = 1_000L)
            val next = withTimeout(2_000L) { UssdSimLock.acquire(2, "wallet-lookup:NEXT", arrivalTimeMs = 1_001L) }
            assertEquals("wallet-lookup:NEXT", UssdSimLock.status.value.running?.key)
            UssdSimLock.release(stuck) // late: must not free NEXT's turn
            assertEquals("wallet-lookup:NEXT", UssdSimLock.status.value.running?.key)
            UssdSimLock.release(next)
            assertTrue(UssdSimLock.status.value.isIdle)
        } finally {
            UssdSimLock.maxSessionMs = 5 * 60_000L
        }
    }

    @Test
    fun `job keys drop the attempt number and give both Reseller paths one name`() {
        assertEquals("internet_store:O1", normalizeUssdJobKey("internet_store:O1:attempt3"))
        assertEquals("reseller:W1", normalizeUssdJobKey("reseller_withdrawal:W1:attempt1"))
        assertEquals("reseller:W1", normalizeUssdJobKey("reseller:W1"))
        assertEquals("exchange:DEX1", normalizeUssdJobKey("exchange:DEX1"))
        assertEquals("Reseller withdrawal W1", ussdJobLabel("reseller_withdrawal:W1:attempt2"))
        assertEquals("Money Exchange DEX1", ussdJobLabel("exchange:DEX1"))
    }

    @Test
    fun `the job registry refuses a second claim of the same job until it is released`() = runBlocking {
        UssdJobRegistry.resetForTest()
        assertTrue(UssdJobRegistry.claim("reseller:W7"))
        // The other Reseller Withdraw path, same withdrawal: refused.
        assertFalse(UssdJobRegistry.claim("reseller_withdrawal:W7"))
        assertFalse(UssdJobRegistry.claim("reseller:W7"))
        // A different job is unaffected.
        assertTrue(UssdJobRegistry.claim("internet_store:W7"))
        UssdJobRegistry.release("reseller:W7")
        assertTrue(UssdJobRegistry.claim("reseller:W7"))
        UssdJobRegistry.resetForTest()
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
