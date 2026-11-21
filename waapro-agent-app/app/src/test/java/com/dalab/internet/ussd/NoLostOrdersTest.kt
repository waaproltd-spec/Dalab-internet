package com.dalab.internet.ussd

import com.dalab.internet.sms.keepsDurableEntry
import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Live incident DLB547875803: an order must never be left stuck when the
 * app is stopped while it waits in the USSD queue, and a duplicate run must
 * never delete the recovery entry the live run depends on. */
class NoLostOrdersTest {

    @Test
    fun `a duplicate run keeps the recovery entry while the same order runs on this phone`() {
        assertTrue(keepsDurableEntry(DialOutcome.DUPLICATE_SKIPPED, sameOrderRunningHere = true))
    }

    @Test
    fun `a server refusal or any final outcome still clears the entry as before`() {
        // Server said "already handled" -- no live run here: entry is cleared (unchanged behaviour).
        assertFalse(keepsDurableEntry(DialOutcome.DUPLICATE_SKIPPED, sameOrderRunningHere = false))
        for (o in listOf(DialOutcome.SUCCESS, DialOutcome.FAILED, DialOutcome.AMBIGUOUS, DialOutcome.TIMEOUT)) {
            assertFalse(keepsDurableEntry(o, sameOrderRunningHere = true))
        }
    }

    @Test
    fun `journal entries from older app versions read as dialing (never as safe to resend)`() {
        val old = """{"orderId":"DLB1","attemptId":"a1","attemptNumber":1,"simSlot":2,"startedAt":5}"""
        val e = Gson().fromJson(old, DialJournal.Entry::class.java)
        assertNull(e.phase)
        assertFalse(e.phase == DialJournal.PHASE_QUEUED)
    }

    @Test
    fun `a queued entry round-trips with its phase`() {
        val e = DialJournal.Entry("DLB2", "a2", 1, 1, 9L, DialJournal.PHASE_QUEUED)
        val back = Gson().fromJson(Gson().toJson(e), DialJournal.Entry::class.java)
        assertEquals(DialJournal.PHASE_QUEUED, back.phase)
    }
}
