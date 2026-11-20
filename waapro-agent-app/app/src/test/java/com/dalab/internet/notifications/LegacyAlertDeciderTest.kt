package com.dalab.internet.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LegacyAlertDeciderTest {
    private val now = 1_800_000_000_000L
    private val minute = 60_000L

    @Test
    fun aJustAssignedCustomerIsOneNeedsHelpAlert() {
        val d = LegacyAlertDecider.forActiveConversation("c1", now - 10_000, "m1", now - 12_000, now)!!
        assertEquals("assigned", d.alert)
        assertEquals("assigned:c1", d.key)
    }

    @Test
    fun aNewCustomerMessageInAnOlderChatIsAMessageAlertKeyedByMessageId() {
        val d = LegacyAlertDecider.forActiveConversation("c1", now - 30 * minute, "m9", now - 5_000, now)!!
        assertEquals("message", d.alert)
        assertEquals("m9", d.key)
    }

    @Test
    fun oldEventsNeverReAlertOnReconnectOrRefresh() {
        assertNull(LegacyAlertDecider.forActiveConversation("c1", now - 30 * minute, "m1", now - 20 * minute, now))
        assertNull(LegacyAlertDecider.forActiveConversation("c1", null, null, null, now))
        assertNull(LegacyAlertDecider.forWaiting("c2", now - 10 * minute, now))
    }

    @Test
    fun aNewWaitingCustomerAlertsOncePerConversation() {
        val d = LegacyAlertDecider.forWaiting("c2", now - 20_000, now)!!
        assertEquals("waiting", d.alert)
        assertEquals("waiting:c2", d.key)
    }

    @Test
    fun sameEventTwiceGivesTheSameKeySoItIsShownOnce() {
        val deduper = AlertDeduper()
        val a = LegacyAlertDecider.forActiveConversation("c1", now - 5_000, null, null, now)!!
        val b = LegacyAlertDecider.forActiveConversation("c1", now - 5_000, null, null, now + 1_000)!!
        assertEquals(true, deduper.markSeen(a.key))
        assertEquals(false, deduper.markSeen(b.key))
    }
}
