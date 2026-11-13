package com.dalab.internet.ui

import com.dalab.internet.data.SimBalancesResponse
import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class SimBalancesTest {
    @Test
    fun `parses the server's per-SIM list, keeping unknown balances unknown`() {
        val json = """{"sims":[
          {"id":"1","providerKey":"evc_plus","label":"EVC Plus","network":"Hormuud","phoneNumber":"615111111","deviceName":"Mobile A","simSlot":1,"balance":120.5,"updatedAt":"2026-11-13T10:00:00.000Z","source":"sms","status":"ok","message":null},
          {"id":"2","providerKey":"somtel","label":"Somtel","network":"Somtel","phoneNumber":"625222222","deviceName":"Mobile A","simSlot":2,"balance":null,"status":"no_balance_yet","message":"No balance received yet for this SIM"}
        ],"staleHours":24}"""
        val r = Gson().fromJson(json, SimBalancesResponse::class.java)
        assertEquals(2, r.sims.size)
        assertEquals(120.5, r.sims[0].balance!!, 0.0001)
        assertNull("no made-up 0", r.sims[1].balance)
        assertEquals("no_balance_yet", r.sims[1].status)
    }

    @Test
    fun `balance and update texts`() {
        assertEquals("$120.50", simBalanceText(120.5))
        assertNull(simBalanceText(null))
        val now = Instant.parse("2026-11-13T12:00:00Z")
        assertEquals("Updated 5 min ago · SMS", simUpdatedText("2026-11-13T11:55:00Z", "sms", now))
        assertEquals("Updated 3 h ago · USSD reply", simUpdatedText("2026-11-13T09:00:00Z", "ussd_dial", now))
        assertNull(simUpdatedText(null, "sms", now))
    }
}
