package com.dalab.internet.sms

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/** The SMS broadcast is released quickly even while the work (upload, match,
 * USSD dial) keeps going -- the cause of "AGENT APP isn't responding". */
class SmsReceiverFinishTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Test
    fun `quick work releases the broadcast as soon as it is done`() = runBlocking {
        val finished = AtomicInteger(0)
        val job = scope.launch { delay(20) }
        val started = System.currentTimeMillis()
        finishWhenDoneOrAfter(scope, job, 5_000L) { finished.incrementAndGet() }.join()
        assertEquals(1, finished.get())
        assertTrue(System.currentTimeMillis() - started < 2_000L)
    }

    @Test
    fun `slow work (a long USSD dial) releases the broadcast after the limit and keeps running`() = runBlocking {
        val finished = AtomicInteger(0)
        val workDone = AtomicInteger(0)
        val job = scope.launch { delay(600); workDone.incrementAndGet() }
        val started = System.currentTimeMillis()
        finishWhenDoneOrAfter(scope, job, 100L) { finished.incrementAndGet() }.join()
        val waited = System.currentTimeMillis() - started
        assertEquals(1, finished.get())
        assertTrue("released near the limit, not after the work ($waited ms)", waited < 500L)
        assertFalse("the work is still running", job.isCompleted)
        job.join()
        assertEquals("the work still finished", 1, workDone.get())
        assertEquals("released exactly once", 1, finished.get())
    }

    @Test
    fun `work that is stopped still releases the broadcast once`() = runBlocking {
        val finished = AtomicInteger(0)
        val job = scope.launch { delay(10_000) }
        job.cancel()
        finishWhenDoneOrAfter(scope, job, 1_000L) { finished.incrementAndGet() }.join()
        assertEquals(1, finished.get())
    }

    @Test
    fun `the hold is well under Android's 10-second broadcast limit`() {
        assertTrue(SmsReceiver.BROADCAST_HOLD_MS in 1_000L..9_000L)
    }
}
