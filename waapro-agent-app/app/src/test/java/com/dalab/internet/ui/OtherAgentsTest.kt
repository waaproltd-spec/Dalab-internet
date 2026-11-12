package com.dalab.internet.ui

import com.dalab.internet.data.OtherAgentsResponse
import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class OtherAgentsTest {

    @Test
    fun `parses the server's other-agents answer, with and without phone numbers`() {
        val json = """{"agents":[{"id":"a1","name":"Amina","phone":"252611234567","online":true,"status":"ONLINE","lastSeenAt":"2026-11-12T10:00:00.000Z"},
            {"id":"a2","name":"Cali","phone":null,"online":false,"status":"OFFLINE","lastSeenAt":null}],
            "phoneVisible":true,"onlineWindowSeconds":180,"onlineCount":1,"serverTime":"2026-11-12T10:01:00.000Z"}"""
        val r = Gson().fromJson(json, OtherAgentsResponse::class.java)
        assertEquals(2, r.agents.size)
        assertTrue(r.agents[0].online)
        assertEquals("252611234567", r.agents[0].phone)
        assertFalse(r.agents[1].online)
        assertNull(r.agents[1].phone)
        assertTrue(r.phoneVisible)
        assertEquals(1, r.onlineCount)
    }

    @Test
    fun `last seen reads as minutes, hours or days`() {
        val now = Instant.parse("2026-11-12T12:00:00Z")
        assertEquals("just now", lastSeenText("2026-11-12T11:59:40Z", now))
        assertEquals("5 min ago", lastSeenText("2026-11-12T11:55:00Z", now))
        assertEquals("3 h ago", lastSeenText("2026-11-12T09:00:00Z", now))
        assertEquals("2 days ago", lastSeenText("2026-11-10T11:00:00Z", now))
        assertNull(lastSeenText(null, now))
        assertNull(lastSeenText("not a date", now))
    }
}
