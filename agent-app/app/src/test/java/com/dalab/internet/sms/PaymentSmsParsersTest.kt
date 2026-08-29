package com.dalab.internet.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pure-logic unit tests for the three currently-supported real incoming-
 * payment SMS formats (see PaymentSmsParsers.kt's own doc comments for
 * where each sample body came from — every body used here is copied
 * verbatim from those comments, not invented). Runs on the plain JVM (no
 * Android framework calls in tryParse itself), so no emulator/device is
 * needed.
 *
 * Deliberately does NOT touch SmsSenderIdRepository's cache (relies on its
 * hardcoded defaults, which sendersFor() falls back to whenever the cache
 * is empty — exactly the state a fresh, offline, or just-installed Agent
 * App is in) so these tests exercise the same fallback path a real device
 * uses before its first successful GET /agent/sms-sender-ids.
 */
class PaymentSmsParsersTest {

    // ==================== Provider 1: Hormuud EVC Plus (sender 192) ====================

    @Test
    fun `Hormuud EVC Plus real SMS from sender 192 parses amount, phone, and provider`() {
        val entry = PaymentSmsParsers.parse(
            sender = "192",
            body = "[-EVCPLUS-] waxaad $1 ka heshay 0610346060, Tar: 24/07/26",
            receivedAt = "2026-07-24T10:00:00+03:00",
        )
        assertEquals("Hormuud", entry?.parsedProvider)
        assertEquals(1.0, entry?.parsedAmount)
        assertEquals("0610346060", entry?.parsedPhone)
    }

    @Test
    fun `Hormuud EVC Plus also parses from the EVCPLUS text sender alias`() {
        val entry = PaymentSmsParsers.parse(
            sender = "EVCPLUS",
            body = "[-EVCPLUS-] waxaad $0.1 ka heshay 0610346060, Tar: 24/07/26",
            receivedAt = "2026-07-24T10:00:00+03:00",
        )
        assertEquals("Hormuud", entry?.parsedProvider)
        assertEquals(0.1, entry?.parsedAmount)
    }

    @Test
    fun `Hormuud EVC Plus parses a small real payment amount exactly, no rounding`() {
        val entry = PaymentSmsParsers.parse(
            sender = "192",
            body = "[-EVCPLUS-] waxaad $0.09 ka heshay 0610346060, Tar: 24/07/26",
            receivedAt = "2026-07-24T10:00:00+03:00",
        )
        assertEquals(0.09, entry?.parsedAmount)
    }

    @Test
    fun `Hormuud EVC Plus rejects an SMS from an untrusted sender, even with an identical body`() {
        val entry = PaymentSmsParsers.parse(
            sender = "12345",
            body = "[-EVCPLUS-] waxaad $1 ka heshay 0610346060, Tar: 24/07/26",
            receivedAt = "2026-07-24T10:00:00+03:00",
        )
        assertNull("an SMS spoofing this exact body from an unrecognized sender must never be trusted as a real payment", entry)
    }

    // ==================== Provider 2: Somtel eDahab (sender "eDahab") ====================

    @Test
    fun `Somtel eDahab real SMS format parses amount, phone, provider, and transaction reference`() {
        val entry = PaymentSmsParsers.parse(
            sender = "eDahab",
            body = "0.22 Dollar Ayaad Ka Heshay Yaasiin Maxamed Aadan.Code-ka:NA.Lambarka :620346060  " +
                "Aqanoosiga : PP260718.0005.F75709 Haraagaaga Cusubi Waa: 2.61 Dollar..Tariikh:18-07-2026[-eDahab-Service-]",
            receivedAt = "2026-07-18T10:00:00+03:00",
        )
        assertEquals("Somtel", entry?.parsedProvider)
        assertEquals(0.22, entry?.parsedAmount)
        assertEquals("620346060", entry?.parsedPhone)
        assertEquals("PP260718.0005.F75709", entry?.transactionRef)
    }

    @Test
    fun `Somtel eDahab still parses correctly when the reference field is missing`() {
        val entry = PaymentSmsParsers.parse(
            sender = "eDahab",
            body = "0.5 Dollar Ayaad Ka Heshay Some Customer.Lambarka :620346099 Haraagaaga Cusubi Waa: 3.00 Dollar.[-eDahab-Service-]",
            receivedAt = "2026-07-18T10:00:00+03:00",
        )
        assertEquals("Somtel", entry?.parsedProvider)
        assertEquals(0.5, entry?.parsedAmount)
        assertEquals("620346099", entry?.parsedPhone)
        assertNull("a missing Aqanoosiga field must not break basic amount+phone parsing", entry?.transactionRef)
    }

    @Test
    fun `Somtel eDahab does not match a body lacking the distinctive eDahab tag, even from the right sender`() {
        val entry = PaymentSmsParsers.parse(
            sender = "eDahab",
            body = "Some unrelated message with no payment content at all.",
            receivedAt = "2026-07-18T10:00:00+03:00",
        )
        assertNull(entry)
    }

    // ==================== Provider 3: Somnet EVC-Plus-branded (also sender 192) ====================

    @Test
    fun `Somnet EVC Plus real SMS format parses correctly and is tagged Somnet, not Hormuud`() {
        val entry = PaymentSmsParsers.parse(
            sender = "192",
            body = "[-EVCPlus-] $0.1 ayaad ka Heshay AARAN DATA SERVICE (252685115555),27/07/26 04:49:01 via Somnet Telecom, " +
                "Haraagaagu waa $4.95.",
            receivedAt = "2026-07-27T04:49:01+03:00",
        )
        assertEquals("Somnet", entry?.parsedProvider)
        assertEquals(0.1, entry?.parsedAmount)
        assertEquals("252685115555", entry?.parsedPhone)
    }

    @Test
    fun `sender 192 is disambiguated correctly between Hormuud and Somnet formats, never confused`() {
        val hormuud = PaymentSmsParsers.parse(
            sender = "192",
            body = "[-EVCPLUS-] waxaad $2 ka heshay 0610346060, Tar: 24/07/26",
            receivedAt = "2026-07-24T10:00:00+03:00",
        )
        val somnet = PaymentSmsParsers.parse(
            sender = "192",
            body = "[-EVCPlus-] $2 ayaad ka Heshay AARAN DATA SERVICE (252685115555),27/07/26 04:49:01 via Somnet Telecom, Haraagaagu waa $4.95.",
            receivedAt = "2026-07-27T04:49:01+03:00",
        )
        assertEquals("Hormuud", hormuud?.parsedProvider)
        assertEquals("Somnet", somnet?.parsedProvider)
    }

    // ==================== Cross-cutting safety ====================

    @Test
    fun `an ordinary personal text or OTP matches no parser at all`() {
        assertNull(PaymentSmsParsers.parse("254712345", "Your OTP is 445566. Do not share it.", "2026-07-24T10:00:00+03:00"))
        assertNull(PaymentSmsParsers.parse("Mom", "Call me when you're free", "2026-07-24T10:00:00+03:00"))
    }

    @Test
    fun `simSlot metadata is attached to whichever provider matched, without affecting parsing`() {
        val entry = PaymentSmsParsers.parse(
            sender = "192",
            body = "[-EVCPLUS-] waxaad $1 ka heshay 0610346060, Tar: 24/07/26",
            receivedAt = "2026-07-24T10:00:00+03:00",
            simSlot = 2,
        )
        assertEquals(2, entry?.simSlot)
        assertEquals(1.0, entry?.parsedAmount)
    }
}
