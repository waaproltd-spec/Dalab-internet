package com.dalab.internet.sms

import com.dalab.internet.network.SmsFormatDto
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * SMS Format Update on the phone. The patterns below are exactly what the
 * backend's generator (admin-backend-ts/src/utils/smsFormats.ts) produces
 * for each real SMS, so these tests prove java.util.regex reads them the
 * same way the dashboard's Test SMS did.
 */
class DynamicSmsFormatsTest {
    private val newEdahab =
        "0.09 Dollar Ayaad ka Heshay Yaasiin Maxamed Aadan  (620346060). Tix: PP261009.1511.117314. HHaraagaagu waa: 0.77 Dollar. " +
            "Tar: 09-10-2026 15:11 PM [eDahab Service-Dollar] La soo dag App-ka DahabPlus https://onelink.to/dahabpluss"

    private val edahabFormat = SmsFormatDto(
        id = "f1",
        provider = "edahab",
        parsedProvider = "Somtel",
        version = 2,
        pattern = """([\d,]+(?:\.\d+)?)\s*Dollar[\s\S]*?\(\s*(\d{6,15})\s*\)(?:[\s\S]*?Tix\s*:\s*([A-Za-z0-9][A-Za-z0-9.\-]*[A-Za-z0-9]))?""",
        amountGroup = 1,
        senderGroup = 2,
        referenceGroup = 3,
        keywords = listOf("Ayaad ka Heshay", "eDahab"),
        senders = listOf("eDahab"),
    )

    private val evcFormat = SmsFormatDto(
        id = "f2",
        provider = "evc_plus",
        parsedProvider = "Hormuud",
        version = 1,
        pattern = """\$\s*([\d,]+(?:\.\d+)?)[\s\S]*?\b(\d{6,15})\b""",
        amountGroup = 1,
        senderGroup = 2,
        keywords = listOf("waxaad", "ka heshay", "EVCPLUS"),
        senders = listOf("192", "EVCPLUS"),
    )

    @After
    fun clear() = DynamicSmsFormats.replace(emptyList())

    @Test
    fun `reads the new eDahab wording - payment amount not balance, payer number, Tix reference`() {
        DynamicSmsFormats.replace(listOf(edahabFormat))
        val entry = PaymentSmsParsers.parse("eDahab", newEdahab, "2026-10-09T15:11:00+03:00", simSlot = 2)
        assertNotNull(entry)
        assertEquals("Somtel", entry?.parsedProvider)
        assertEquals(0.09, entry?.parsedAmount)
        assertEquals("620346060", entry?.parsedPhone)
        assertEquals("PP261009.1511.117314", entry?.transactionRef)
        assertEquals(2, entry?.simSlot)
    }

    @Test
    fun `reads later SMS of the same wording with other values, including thousands separators`() {
        DynamicSmsFormats.replace(listOf(edahabFormat))
        val later = newEdahab.replace("0.09", "1,250.5").replace("620346060", "615551234").replace("PP261009.1511.117314", "PP261010.0900.E00001")
        val entry = DynamicSmsFormats.tryParse("eDahab", later, "2026-10-10T09:00:00+03:00")
        assertEquals(1250.5, entry?.parsedAmount)
        assertEquals("615551234", entry?.parsedPhone)
        assertEquals("PP261010.0900.E00001", entry?.transactionRef)
    }

    @Test
    fun `a format never reads SMS from another provider's sender`() {
        DynamicSmsFormats.replace(listOf(edahabFormat))
        assertNull(DynamicSmsFormats.tryParse("192", newEdahab, "2026-10-09T15:11:00+03:00"))
    }

    @Test
    fun `a format needs all its keywords - an outgoing transfer from the same sender is not a payment`() {
        DynamicSmsFormats.replace(listOf(edahabFormat))
        val sent = newEdahab.replace("Ayaad ka Heshay", "ayad u warejisay")
        assertNull(DynamicSmsFormats.tryParse("eDahab", sent, "2026-10-09T15:11:00+03:00"))
    }

    @Test
    fun `an EVC Plus format doesn't take Somnet's SMS from the shared 192 sender - the built-in Somnet parser still does`() {
        DynamicSmsFormats.replace(listOf(evcFormat))
        val somnet = "[-EVCPlus-] \$0.1 ayaad ka Heshay AARAN DATA SERVICE (252685115555),27/07/26 04:49:01 via Somnet Telecom, Haraagaagu waa \$4.95."
        assertNull(DynamicSmsFormats.tryParse("192", somnet, "2026-07-27T04:49:01+03:00"))
        assertEquals("Somnet", PaymentSmsParsers.parse("192", somnet, "2026-07-27T04:49:01+03:00")?.parsedProvider)

        val hormuud = "[-EVCPLUS-] waxaad \$0.1 ka heshay 0610346060, Tar: 24/07/26"
        assertEquals("0610346060", DynamicSmsFormats.tryParse("192", hormuud, "2026-07-24T10:00:00+03:00")?.parsedPhone)
    }

    @Test
    fun `non-breaking spaces read the same as normal spaces`() {
        DynamicSmsFormats.replace(listOf(edahabFormat))
        val withNbsp = newEdahab.replace("Ayaad ka Heshay", "Ayaad\u00A0ka\u00A0Heshay")
        assertEquals(0.09, DynamicSmsFormats.tryParse("eDahab", withNbsp, "2026-10-09T15:11:00+03:00")?.parsedAmount)
    }

    @Test
    fun `with no active formats the built-in parsers work exactly as before`() {
        DynamicSmsFormats.replace(emptyList())
        val old = "0.22 Dollar Ayaad Ka Heshay Yaasiin Maxamed Aadan.Code-ka:NA.Lambarka :620346060  " +
            "Aqanoosiga : PP260718.0005.F75709 Haraagaaga Cusubi Waa: 2.61 Dollar..Tariikh:18-07-2026[-eDahab-Service-]"
        assertEquals("620346060", PaymentSmsParsers.parse("eDahab", old, "2026-07-18T10:00:00+03:00")?.parsedPhone)
    }
}
