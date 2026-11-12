package com.dalab.internet.ussd

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * Proves [UssdSimLock] and [InteractiveUssdScreenLock] compose correctly the
 * exact way [ExchangeUssdOrchestrator], [WalletLookupUssdOrchestrator], AND
 * [ResellerWithdrawalInteractiveUssdOrchestrator] actually use them: acquire
 * [UssdSimLock] for this flow's own SIM slot first, THEN
 * [InteractiveUssdScreenLock], and release in the reverse order. Neither
 * [UssdSimLockTest] nor [InteractiveUssdScreenLockTest] alone proves this
 * composition is deadlock-free or behaves as intended -- each only exercises
 * its own lock in isolation.
 */
class UssdSimLockAndInteractiveUssdScreenLockOrderingTest {

    @Before
    fun setUp() = runBlocking {
        UssdSimLock.debounceMs = 20L
        UssdSimLock.resetForTest()
    }

    /** Mirrors all three orchestrators' own acquire/release shape exactly:
     * UssdSimLock first, InteractiveUssdScreenLock second; released in
     * reverse order in `finally`. */
    private suspend fun simulateFlow(
        simSlot: Int,
        requestId: String,
        arrivalTimeMs: Long,
        holdMs: Long,
        screenActiveCount: AtomicInteger,
        maxObservedScreenActive: AtomicInteger,
        order: MutableList<String>,
    ) {
        val ticket = UssdSimLock.acquire(simSlot, requestId, arrivalTimeMs)
        InteractiveUssdScreenLock.acquire()
        try {
            synchronized(order) { order.add(requestId) }
            val now = screenActiveCount.incrementAndGet()
            maxObservedScreenActive.updateAndGet { maxOf(it, now) }
            delay(holdMs)
        } finally {
            screenActiveCount.decrementAndGet()
            InteractiveUssdScreenLock.release()
            UssdSimLock.release(ticket)
        }
    }

    @Test
    fun `a real payout and a wallet lookup on DIFFERENT SIM slots both proceed, but never share the screen at the same instant`() = runBlocking {
        val screenActiveCount = AtomicInteger(0)
        val maxObservedScreenActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        // Exact shape of the live incident this whole fix closes: a real
        // Exchange payout on SIM 1 and a Wallet Lookup on SIM 3, both
        // starting at roughly the same time.
        val payout = async {
            simulateFlow(1, "exchange:DEX1", arrivalTimeMs = 1_000L, holdMs = 40L, screenActiveCount, maxObservedScreenActive, order)
        }
        val lookup = async {
            simulateFlow(3, "wallet-lookup:WL1", arrivalTimeMs = 1_005L, holdMs = 40L, screenActiveCount, maxObservedScreenActive, order)
        }
        payout.await()
        lookup.await()

        assertEquals("both flows should have actually run", 2, order.size)
        assertEquals(
            "UssdSimLock alone would let these two run fully concurrently (different slots) -- " +
                "InteractiveUssdScreenLock must still stop them from ever holding the screen at the same instant",
            1,
            maxObservedScreenActive.get(),
        )
    }

    @Test
    fun `a Reseller Withdrawal on a THIRD SIM slot also serializes against the other two, despite using a separate bridge`() = runBlocking {
        val screenActiveCount = AtomicInteger(0)
        val maxObservedScreenActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        // The gap this generalization specifically closes: Reseller
        // Withdraw drives a completely separate bridge/accessibility
        // service from Exchange/Wallet Lookup, so per-bridge state alone
        // could never have protected it -- only a lock with no bridge
        // affiliation at all (this one) can.
        val payout = async {
            simulateFlow(1, "exchange:DEX1", arrivalTimeMs = 1_000L, holdMs = 30L, screenActiveCount, maxObservedScreenActive, order)
        }
        val lookup = async {
            simulateFlow(2, "wallet-lookup:WL1", arrivalTimeMs = 1_010L, holdMs = 30L, screenActiveCount, maxObservedScreenActive, order)
        }
        val reseller = async {
            simulateFlow(3, "reseller:WDR1", arrivalTimeMs = 1_020L, holdMs = 30L, screenActiveCount, maxObservedScreenActive, order)
        }
        payout.await()
        lookup.await()
        reseller.await()

        assertEquals("all three flows should have actually run", 3, order.size)
        assertEquals(1, maxObservedScreenActive.get())
    }

    @Test
    fun `two flows on the SAME SIM slot are still serialized by UssdSimLock as before`() = runBlocking {
        val screenActiveCount = AtomicInteger(0)
        val maxObservedScreenActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        val a = async { simulateFlow(1, "exchange:DEX1", arrivalTimeMs = 1_000L, holdMs = 30L, screenActiveCount, maxObservedScreenActive, order) }
        val b = async { simulateFlow(1, "wallet-lookup:WL1", arrivalTimeMs = 1_010L, holdMs = 30L, screenActiveCount, maxObservedScreenActive, order) }
        a.await()
        b.await()

        assertEquals(listOf("exchange:DEX1", "wallet-lookup:WL1"), order)
        assertEquals(1, maxObservedScreenActive.get())
    }

    @Test
    fun `six flows across three SIM slots all complete with no deadlock, holding the screen one at a time`() = runBlocking {
        val screenActiveCount = AtomicInteger(0)
        val maxObservedScreenActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        val jobs = (1..6).map { i ->
            val slot = (i % 3) + 1
            async {
                simulateFlow(slot, "flow$i", arrivalTimeMs = 1_000L + i, holdMs = 15L, screenActiveCount, maxObservedScreenActive, order)
            }
        }
        jobs.forEach { it.await() }

        assertEquals("every flow must complete -- a real deadlock would hang this test until the runner's own timeout", 6, order.size)
        assertTrue("at most one flow may ever hold the screen lock at once", maxObservedScreenActive.get() == 1)
    }
}
