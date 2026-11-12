package com.dalab.internet.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class AlertDeduperTest {

    @Test
    fun sameEventDeliveredRepeatedlyIsHandledOnce() {
        val deduper = AlertDeduper()
        val key = AlertDeduper.keyFor("message", "conv-1", "msg-1")
        val shown = (1..5).count { deduper.markSeen(key) }
        assertEquals(1, shown)
    }

    @Test
    fun liveStreamAndPushForTheSameMessageShareOneKey() {
        // SSE path has only the id; the push also carries a preview -- same key.
        val fromStream = AlertDeduper.keyFor("message", "conv-1", "msg-1")
        val fromPush = AlertDeduper.keyFor("message", "conv-1", "msg-1", "Salaan")
        assertEquals(fromStream, fromPush)
    }

    @Test
    fun differentMessagesAreDifferentEvents() {
        val deduper = AlertDeduper()
        assertTrue(deduper.markSeen(AlertDeduper.keyFor("message", "conv-1", "msg-1")))
        assertTrue(deduper.markSeen(AlertDeduper.keyFor("message", "conv-1", "msg-2")))
    }

    @Test
    fun assignmentAndWaitingAlertsAreOncePerConversation() {
        val deduper = AlertDeduper()
        assertTrue(deduper.markSeen(AlertDeduper.keyFor("assigned", "conv-1", "first-msg")))
        assertFalse(deduper.markSeen(AlertDeduper.keyFor("assigned", "conv-1", null)))
        assertTrue(deduper.markSeen(AlertDeduper.keyFor("waiting", "conv-2", null)))
        assertFalse(deduper.markSeen(AlertDeduper.keyFor("waiting", "conv-2", "anything")))
    }

    @Test
    fun keyWithoutMessageIdIsStableAcrossRedeliveries() {
        // Never time-based: the same old-backend push redelivered maps to the same key.
        val a = AlertDeduper.keyFor("message", "conv-1", null, "Hello")
        Thread.sleep(5)
        val b = AlertDeduper.keyFor("message", "conv-1", null, "Hello")
        assertEquals(a, b)
        assertNotEquals(a, AlertDeduper.keyFor("message", "conv-1", null, "Different"))
    }

    @Test
    fun concurrentDeliveriesStillShowOnlyOnce() {
        val deduper = AlertDeduper()
        val key = AlertDeduper.keyFor("message", "conv-1", "msg-race")
        val shown = AtomicInteger(0)
        val pool = Executors.newFixedThreadPool(8)
        repeat(64) { pool.execute { if (deduper.markSeen(key)) shown.incrementAndGet() } }
        pool.shutdown()
        assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS))
        assertEquals(1, shown.get())
    }

    @Test
    fun isSeenDoesNotRecord() {
        val deduper = AlertDeduper()
        val key = AlertDeduper.keyFor("message", "conv-1", "msg-1")
        assertFalse(deduper.isSeen(key))
        assertTrue(deduper.markSeen(key))
        assertTrue(deduper.isSeen(key))
    }

    @Test
    fun oldestKeysAreForgottenBeyondCapacity() {
        val deduper = AlertDeduper(capacity = 2)
        deduper.markSeen("a")
        deduper.markSeen("b")
        deduper.markSeen("c")
        assertFalse(deduper.isSeen("a"))
        assertTrue(deduper.isSeen("c"))
    }
}
