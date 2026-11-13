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

    private fun sim(key: String, balance: Double?, status: String = "ok", slot: Int = 1, phone: String? = "610338686") =
        com.dalab.internet.data.SimBalance(id = key + balance + status, providerKey = key, label = key, network = "N", balance = balance, status = status, simSlot = slot, phoneNumber = phone)

    @Test
    fun `logo cards add confirmed SIM balances per network and never invent 0`() {
        val cards = balanceCardsFromSims(listOf(
            sim("evc_plus", 1.76),
            sim("edahab", 17.17, slot = 2, phone = "620338686"),
            sim("hormuud", 27.01), sim("hormuud_evoucher", 5.0),
            sim("somtel", 9.75, "stale"),
            sim("somnet", null, "no_balance_yet"),
        )).associateBy { it.providerKey }
        assertEquals(listOf("evc_plus", "edahab", "hormuud", "somnet", "somtel", "amtel"), balanceCardsFromSims(emptyList()).map { it.providerKey })
        assertEquals(1.76, cards["evc_plus"]!!.amount!!, 0.001)
        assertEquals("610338686 · SIM 1", cards["evc_plus"]!!.note)
        assertEquals("the card names the real slot", "620338686 · SIM 2", cards["edahab"]!!.note)
        assertEquals("Hormuud data only, E-Voucher listed but not added", 27.01, cards["hormuud"]!!.amount!!, 0.001)
        assertEquals(2, cards["hormuud"]!!.sims.size)
        assertEquals(9.75, cards["somtel"]!!.amount!!, 0.001)
        assertEquals("1 SIM needs check", cards["somtel"]!!.note)
        assertNull("configured but no confirmed balance: Unknown, not 0", cards["somnet"]!!.amount)
        assertEquals(true, cards["somnet"]!!.configured)
        assertNull(cards["amtel"]!!.amount)
        assertEquals("no SIM set up", false, cards["amtel"]!!.configured)
    }
}

