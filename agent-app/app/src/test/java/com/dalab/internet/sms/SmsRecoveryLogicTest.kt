package com.dalab.internet.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone-side decisions behind reliable SMS intake. Together with the
 * backend's own dedup tests (smsLogs.routes.ts: transaction reference,
 * sender+body+minute, one active payment per order), these cover the
 * required scenarios: SMS while the app is open/backgrounded/the listener
 * inactive, process death and reboot (persisted checkpoint + ledger), no
 * internet then restored (queue + backoff + forced retry), SMS arriving close
 * together, the same SMS seen by both the receiver and recovery, and a lost
 * acknowledgement.
 */
class SmsRecoveryLogicTest {

    private val evcBody = "[-EVCPLUS-] waxaad \$0.55 ka heshay 0619991299, Tar: 14/10/26 13:04:52 haraagagu waa \$58.805. La soo deg App-ka WAAFI http://onelink.to/waafi"
    private val min = 60_000L
    private val now = 1_800_000_000_000L

    private fun msg(body: String, at: Long, sender: String = "192", sub: Int? = 2) = SmsRecoveryLogic.InboxMessage(sender, body, at, sub)

    // --- identity ---------------------------------------------------------

    @Test fun `the same SMS has the same fingerprint wherever it was found`() {
        val receiver = SmsRecoveryLogic.fingerprint("192", evcBody)
        val recovery = SmsRecoveryLogic.fingerprint(" 192 ", "$evcBody\n")
        assertEquals(receiver, recovery)
        assertEquals(64, receiver.length)
    }

    @Test fun `two different payments never share a fingerprint`() {
        val second = evcBody.replace("13:04:52", "13:05:10")
        assertNotEquals(SmsRecoveryLogic.fingerprint("192", evcBody), SmsRecoveryLogic.fingerprint("192", second))
        assertNotEquals(SmsRecoveryLogic.fingerprint("192", evcBody), SmsRecoveryLogic.fingerprint("eDahab", evcBody))
    }

    @Test fun `sender case doesn't change the identity`() {
        assertEquals(SmsRecoveryLogic.fingerprint("eDahab", "x"), SmsRecoveryLogic.fingerprint("EDAHAB", "x"))
    }

    // --- what a recovery pass reads ----------------------------------------

    @Test fun `first pass after install or data clear reads the last 24 hours`() {
        assertEquals(now - SmsRecoveryLogic.LOOKBACK_MS, SmsRecoveryLogic.recoveryCutoff(0L, now))
    }

    @Test fun `later passes overlap the previous checkpoint so an SMS written mid-pass is never skipped`() {
        val checkpoint = now - 10 * min
        assertEquals(checkpoint - SmsRecoveryLogic.OVERLAP_MS, SmsRecoveryLogic.recoveryCutoff(checkpoint, now))
    }

    @Test fun `after a long time off (reboot, phone off) it still reads at most 24 hours back`() {
        val checkpoint = now - 3 * SmsRecoveryLogic.LOOKBACK_MS
        assertEquals(now - SmsRecoveryLogic.LOOKBACK_MS, SmsRecoveryLogic.recoveryCutoff(checkpoint, now))
    }

    @Test fun `an SMS the listener never saw (inactive or app killed) is recovered`() {
        val todo = SmsRecoveryLogic.messagesToRecover(listOf(msg(evcBody, now - 5 * min))) { false }
        assertEquals(1, todo.size)
        assertEquals(2, todo[0].subscriptionId) // its SIM goes up with it
    }

    @Test fun `an SMS the receiver already handled (acknowledged or still queued) is not taken in again`() {
        val handled = setOf(SmsRecoveryLogic.fingerprint("192", evcBody))
        val todo = SmsRecoveryLogic.messagesToRecover(listOf(msg(evcBody, now - 5 * min))) { it in handled }
        assertTrue(todo.isEmpty())
    }

    @Test fun `several SMS arriving close together are all recovered, oldest first, each once`() {
        val a = msg(evcBody, now - 3_000)
        val b = msg(evcBody.replace("\$0.55", "\$0.20").replace("13:04:52", "13:04:53"), now - 2_000)
        val c = msg(evcBody.replace("\$0.55", "\$1.00").replace("13:04:52", "13:04:54"), now - 1_000)
        val todo = SmsRecoveryLogic.messagesToRecover(listOf(c, a, b, a.copy(dateMs = now - 2_500))) { false }
        assertEquals(listOf(a.body, b.body, c.body), todo.map { it.body })
    }

    // --- retry backoff ------------------------------------------------------

    @Test fun `a failed upload backs off 30s, 1m, 2m ... and never stops retrying`() {
        assertEquals(0L, SmsRecoveryLogic.backoffMs(0))
        assertEquals(30_000L, SmsRecoveryLogic.backoffMs(1))
        assertEquals(60_000L, SmsRecoveryLogic.backoffMs(2))
        assertEquals(120_000L, SmsRecoveryLogic.backoffMs(3))
        assertEquals(SmsRecoveryLogic.BACKOFF_MAX_MS, SmsRecoveryLogic.backoffMs(10))
        assertEquals(SmsRecoveryLogic.BACKOFF_MAX_MS, SmsRecoveryLogic.backoffMs(500))
    }

    @Test fun `an SMS saved with no internet is retried when due, and immediately once connectivity returns`() {
        val lastFailed = now - 20_000
        assertTrue(SmsRecoveryLogic.isDueForRetry(0, 0L, now, force = false)) // never tried
        assertFalse(SmsRecoveryLogic.isDueForRetry(1, lastFailed, now, force = false)) // within 30s
        assertTrue(SmsRecoveryLogic.isDueForRetry(1, now - 31_000, now, force = false))
        assertTrue(SmsRecoveryLogic.isDueForRetry(9, lastFailed, now, force = true)) // network restored
    }

    // --- ledger (survives restarts via SmsFingerprintStore) -----------------

    @Test fun `received, queued, acknowledged: an acknowledged SMS is never put back to queued`() {
        val ledger = SmsIntakeLedger()
        val fp = SmsRecoveryLogic.fingerprint("192", evcBody)
        assertNull(ledger.state(fp))
        ledger.markQueued(fp, now)
        assertEquals(SmsIntakeLedger.State.QUEUED, ledger.state(fp))
        ledger.markAcked(fp, now + 1)
        ledger.markQueued(fp, now + 2) // a late recovery pass finding it again
        assertEquals(SmsIntakeLedger.State.ACKED, ledger.state(fp))
    }

    @Test fun `lost acknowledgement: the SMS stays queued and goes up again; the server's dedup answers duplicate`() {
        // Upload reached the server but the reply was lost -> still QUEUED,
        // so it's retried (not dropped). The backend recognises the same SMS
        // (transaction ref / sender+body+minute) and answers "duplicate";
        // that answer acknowledges it here and it is never sent again.
        val ledger = SmsIntakeLedger()
        val fp = SmsRecoveryLogic.fingerprint("192", evcBody)
        ledger.markQueued(fp, now)
        assertEquals(SmsIntakeLedger.State.QUEUED, ledger.state(fp))
        ledger.markAcked(fp, now + 60_000)
        val todo = SmsRecoveryLogic.messagesToRecover(listOf(msg(evcBody, now))) { ledger.state(it) == SmsIntakeLedger.State.ACKED }
        assertTrue(todo.isEmpty())
    }

    @Test fun `the ledger keeps what recovery can still see and forgets old entries`() {
        val ledger = SmsIntakeLedger()
        ledger.markAcked("recent", now - SmsRecoveryLogic.LOOKBACK_MS)
        ledger.markAcked("old", now - SmsIntakeLedger.RETENTION_MS - 1)
        ledger.prune(now)
        assertEquals(SmsIntakeLedger.State.ACKED, ledger.state("recent"))
        assertNull(ledger.state("old"))
    }

    @Test fun `the ledger is bounded`() {
        val ledger = SmsIntakeLedger()
        for (i in 0 until SmsIntakeLedger.MAX_ENTRIES + 50) ledger.markAcked("fp$i", now + i)
        ledger.prune(now + SmsIntakeLedger.MAX_ENTRIES + 50)
        assertEquals(SmsIntakeLedger.MAX_ENTRIES, ledger.snapshot().size)
        assertNull(ledger.state("fp0")) // oldest dropped
        assertEquals(SmsIntakeLedger.State.ACKED, ledger.state("fp${SmsIntakeLedger.MAX_ENTRIES + 49}"))
    }
}
