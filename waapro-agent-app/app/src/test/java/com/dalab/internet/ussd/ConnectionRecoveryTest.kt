package com.dalab.internet.ussd

import com.dalab.internet.network.NetworkStatus
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Connection recovery: an uncertain financial result is never dialed again
 * automatically, and coming back online is signalled exactly once. */
class ConnectionRecoveryTest {

    @Test
    fun `reseller withdrawal never auto-repeats a timeout or an unrecognised reply`() {
        assertFalse(isResellerWithdrawalAutoRetryable(DialResult(DialOutcome.TIMEOUT, "no reply")))
        assertFalse(isResellerWithdrawalAutoRetryable(DialResult(DialOutcome.AMBIGUOUS, "?")))
        assertTrue(isResellerWithdrawalAutoRetryable(DialResult(DialOutcome.FAILED, "rejected")))
        assertFalse(isResellerWithdrawalAutoRetryable(DialResult(DialOutcome.SUCCESS, "ok")))
    }

    @Test
    fun `internet store recharge never auto-repeats an uncertain result either`() {
        assertFalse(isAutomaticallyRetryable(DialResult(DialOutcome.TIMEOUT, "no reply")))
        assertFalse(isAutomaticallyRetryable(DialResult(DialOutcome.AMBIGUOUS, "?")))
    }

    @Test
    fun `going offline then online emits one reconnect and records when it went offline`() = runBlocking {
        NetworkStatus.set(true, atMs = 1L)
        val reconnect = async { withTimeout(2_000L) { NetworkStatus.reconnected.first() } }
        yield()
        NetworkStatus.set(false, atMs = 100L)
        assertFalse(NetworkStatus.online.value)
        assertEquals(100L, NetworkStatus.lastOfflineAt.value)
        NetworkStatus.set(false, atMs = 150L) // no change: still offline since 100
        assertEquals(100L, NetworkStatus.lastOfflineAt.value)
        NetworkStatus.set(true, atMs = 200L)
        assertTrue(NetworkStatus.online.value)
        assertEquals(200L, reconnect.await())
    }
}
