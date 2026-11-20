package com.dalab.internet.ussd

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.supervisorScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * Regression coverage for [InteractiveUssdScreenLock] -- the fix for a live
 * incident where a real Money Exchange payout on one SIM slot and a Wallet
 * Name Lookup on a DIFFERENT slot both called [ExchangeUssdBridge.arm] on
 * the single shared bridge at the same moment (permitted by [UssdSimLock],
 * which only serializes the DIAL itself, per slot), each silently resetting
 * the other's lockedPackageName/event-channel state -- and generalized to
 * also cover Reseller Withdraw's own SEPARATE bridge/accessibility service,
 * since Android delivers accessibility events to every enabled service
 * regardless of which flow's dial produced them; there is only one physical
 * screen. These tests prove the lock actually serializes concurrent callers
 * regardless of which "slot" or which of the three flows they claim to be --
 * there's no slot parameter or flow-identity parameter here at all, on
 * purpose, since the lock's whole job is "only one interactive dialog at a
 * time, device-wide".
 *
 * Deliberately tests [InteractiveUssdScreenLock] directly rather than
 * through [ExchangeUssdBridge.acquireSession]/[releaseSession] or
 * [ResellerWithdrawalInteractiveUssdBridge.acquireSession]/[releaseSession]:
 * merely referencing either bridge object eagerly constructs a real
 * `Handler(Looper.getMainLooper())`, which throws in a plain JVM unit test
 * (no Robolectric) -- confirmed live, this exact mistake failed every test
 * in an earlier version of this file with ExceptionInInitializerError /
 * NoClassDefFoundError. [InteractiveUssdScreenLock] has no Android imports
 * at all, so it's safe to load and exercise here.
 */
class InteractiveUssdScreenLockTest {

    @Test
    fun `two concurrent sessions on the shared lock never run at the same time`() = runBlocking {
        val activeCount = AtomicInteger(0)
        val maxObservedActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        suspend fun fakeSession(name: String, holdMs: Long) {
            InteractiveUssdScreenLock.acquire()
            try {
                synchronized(order) { order.add(name) }
                val now = activeCount.incrementAndGet()
                maxObservedActive.updateAndGet { maxOf(it, now) }
                delay(holdMs)
            } finally {
                activeCount.decrementAndGet()
                InteractiveUssdScreenLock.release()
            }
        }

        // Simulates the live incident's shape: a real payout (slot 1) and a
        // wallet lookup (slot 3) racing to arm() the same shared bridge.
        val payout = async { fakeSession("exchange:DEX1", holdMs = 40L) }
        val lookup = async { fakeSession("wallet-lookup:WL1", holdMs = 40L) }
        payout.await()
        lookup.await()

        assertEquals("both sessions should have actually run", 2, order.size)
        assertEquals("at most one session may ever hold the lock at once", 1, maxObservedActive.get())
    }

    @Test
    fun `three DIFFERENT flow types -- payout, lookup, and reseller withdrawal -- still never overlap`() = runBlocking {
        val activeCount = AtomicInteger(0)
        val maxObservedActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        suspend fun fakeSession(name: String, holdMs: Long) {
            InteractiveUssdScreenLock.acquire()
            try {
                synchronized(order) { order.add(name) }
                val now = activeCount.incrementAndGet()
                maxObservedActive.updateAndGet { maxOf(it, now) }
                delay(holdMs)
            } finally {
                activeCount.decrementAndGet()
                InteractiveUssdScreenLock.release()
            }
        }

        // Three genuinely different flow types, on three different SIM
        // slots (which UssdSimLock alone would let run fully concurrently)
        // -- exactly the shape of the gap this lock closes: Exchange and
        // Wallet Lookup share ExchangeUssdBridge, but Reseller Withdraw
        // drives a completely separate bridge/accessibility service, and
        // none of the three have any way to recognize each other's dialog.
        val payout = async { fakeSession("exchange:DEX1", holdMs = 30L) }
        val lookup = async { fakeSession("wallet-lookup:WL1", holdMs = 30L) }
        val reseller = async { fakeSession("reseller:WDR1", holdMs = 30L) }
        payout.await()
        lookup.await()
        reseller.await()

        assertEquals("all three sessions should have actually run", 3, order.size)
        assertEquals(
            "no two of these three DIFFERENT flow types may ever hold the screen lock at the same instant, " +
                "even though they use two different bridge objects and three different SIM slots",
            1,
            maxObservedActive.get(),
        )
    }

    @Test
    fun `a session that fails still releases so the next caller is not stuck forever`() = runBlocking {
        supervisorScope {
            val order = mutableListOf<String>()

            val failing = async {
                InteractiveUssdScreenLock.acquire()
                try {
                    order.add("failing")
                    throw IllegalStateException("simulated dial failure")
                } finally {
                    InteractiveUssdScreenLock.release()
                }
            }
            var caught: Throwable? = null
            try {
                failing.await()
            } catch (e: Throwable) {
                caught = e
            }
            assertTrue("the failing session's own exception must propagate", caught != null)

            // Must be able to acquire immediately -- if the failed session's
            // finally hadn't released, this would hang until the test
            // framework's own timeout instead of completing.
            InteractiveUssdScreenLock.acquire()
            order.add("next")
            InteractiveUssdScreenLock.release()

            assertEquals(listOf("failing", "next"), order)
        }
    }

    @Test
    fun `releasing when not held is a safe no-op`() {
        // Never acquired in this test -- must not throw.
        InteractiveUssdScreenLock.release()
    }
}
