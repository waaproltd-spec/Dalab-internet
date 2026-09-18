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
 * Regression coverage for [ExchangeSessionLock] -- the fix for a live
 * incident where a real Money Exchange payout on one SIM slot and a Wallet
 * Name Lookup on a DIFFERENT slot both called [ExchangeUssdBridge.arm] on
 * the single shared bridge at the same moment (permitted by [UssdSimLock],
 * which only serializes the DIAL itself, per slot), each silently resetting
 * the other's lockedPackageName/event-channel state. These tests prove the
 * lock actually serializes concurrent callers regardless of which "slot"
 * they claim to be on -- there's no slot parameter here at all, on purpose,
 * since the bridge itself has no per-slot state to protect.
 *
 * Deliberately tests [ExchangeSessionLock] directly rather than through
 * [ExchangeUssdBridge.acquireSession]/[ExchangeUssdBridge.releaseSession]:
 * merely referencing [ExchangeUssdBridge] eagerly constructs a real
 * `Handler(Looper.getMainLooper())`, which throws in a plain JVM unit test
 * (no Robolectric) -- confirmed live, this exact mistake failed every test
 * in an earlier version of this file with ExceptionInInitializerError /
 * NoClassDefFoundError. [ExchangeSessionLock] has no Android imports at all,
 * so it's safe to load and exercise here.
 */
class ExchangeSessionLockTest {

    @Test
    fun `two concurrent sessions on the shared lock never run at the same time`() = runBlocking {
        val activeCount = AtomicInteger(0)
        val maxObservedActive = AtomicInteger(0)
        val order = mutableListOf<String>()

        suspend fun fakeSession(name: String, holdMs: Long) {
            ExchangeSessionLock.acquire()
            try {
                synchronized(order) { order.add(name) }
                val now = activeCount.incrementAndGet()
                maxObservedActive.updateAndGet { maxOf(it, now) }
                delay(holdMs)
            } finally {
                activeCount.decrementAndGet()
                ExchangeSessionLock.release()
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
    fun `a session that fails still releases so the next caller is not stuck forever`() = runBlocking {
        supervisorScope {
            val order = mutableListOf<String>()

            val failing = async {
                ExchangeSessionLock.acquire()
                try {
                    order.add("failing")
                    throw IllegalStateException("simulated dial failure")
                } finally {
                    ExchangeSessionLock.release()
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
            ExchangeSessionLock.acquire()
            order.add("next")
            ExchangeSessionLock.release()

            assertEquals(listOf("failing", "next"), order)
        }
    }

    @Test
    fun `releasing when not held is a safe no-op`() {
        // Never acquired in this test -- must not throw.
        ExchangeSessionLock.release()
    }
}
