package com.dalab.internet.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Regression coverage for the Hormuud "E-Voucher" (sender 740) outgoing-
 * transfer confirmation format — see HormuudEVoucherPayoutSentParser's doc
 * comment for the full story: this format went completely unparsed for a
 * real, successfully-paid Reseller Withdraw (WDR220317059), captured live
 * three times before this parser existed.
 */
class PaymentSmsParsersTest {

    // The exact real SMS that confirmed WDR220317059's payout — captured
    // live, unaltered except for the customer's name kept as-is from the
    // real message (already public in the carrier's own SMS, not a secret).
    private val realWdr220317059Body =
        "[-E-Voucher-] \$1.05 ayaad uwareejisay YAASIIN MAXAMED AADAN(617080008), Haraagaagu waa \$2.27.\nLa soo deg App-ka WAAFI http://onelink.to/waafi"

    @Test
    fun `sender 740 is recognized`() {
        assertEquals(listOf("740"), HormuudEVoucherPayoutSentParser.senders)
    }

    @Test
    fun `the real WDR220317059 confirmation SMS parses correctly end to end`() {
        val entry = HormuudEVoucherPayoutSentParser.tryParse("740", realWdr220317059Body)
        requireNotNull(entry) { "Expected the real captured SMS to parse — it did not." }
        assertEquals("Hormuud", entry.provider)
        assertEquals(1.05, entry.amount, 0.0001)
        assertEquals("617080008", entry.receiverPhone)
    }

    @Test
    fun `dollar amount 1_05 is parsed correctly`() {
        val entry = HormuudEVoucherPayoutSentParser.tryParse(
            "740",
            "[-E-Voucher-] \$1.05 ayaad uwareejisay YAASIIN MAXAMED AADAN(617080008), Haraagaagu waa \$4.32.\nLa soo deg App-ka WAAFI http://onelink.to/waafi",
        )
        assertEquals(1.05, entry?.amount ?: -1.0, 0.0001)
    }

    @Test
    fun `a whole-dollar amount with no decimal point is still parsed correctly`() {
        // Real captured sample: Hormuud's own SMS omits the decimal for a
        // whole-dollar amount ("$1" not "$1.00").
        val entry = HormuudEVoucherPayoutSentParser.tryParse(
            "740",
            "[-E-Voucher-] \$1 ayaad uwareejisay YAASIIN MAXAMED AADAN(617080008), Haraagaagu waa \$3.32.\nLa soo deg App-ka WAAFI http://onelink.to/waafi",
        )
        assertEquals(1.0, entry?.amount ?: -1.0, 0.0001)
    }

    @Test
    fun `destination phone 617080008 is parsed correctly`() {
        val entry = HormuudEVoucherPayoutSentParser.tryParse("740", realWdr220317059Body)
        assertEquals("617080008", entry?.receiverPhone)
    }

    @Test
    fun `the E-Voucher tag alone is not required to match — the sender plus ayaad uwareejisay wording is what matters`() {
        // Confirms the parser isn't accidentally keyed on the literal
        // "[-E-Voucher-]" tag text (which could vary/be stripped) — only on
        // the sender and the "ayaad uwareejisay...(...)" structure.
        val entry = HormuudEVoucherPayoutSentParser.tryParse(
            "740",
            "\$2.50 ayaad uwareejisay SOME PERSON(615123456), Haraagaagu waa \$10.00.",
        )
        requireNotNull(entry)
        assertEquals(2.50, entry.amount, 0.0001)
        assertEquals("615123456", entry.receiverPhone)
    }

    @Test
    fun `a wrong sender is rejected even with matching wording`() {
        assertNull(HormuudEVoucherPayoutSentParser.tryParse("192", realWdr220317059Body))
    }

    @Test
    fun `an unrelated SMS from sender 740 is rejected`() {
        assertNull(HormuudEVoucherPayoutSentParser.tryParse("740", "Your OTP code is 1234"))
    }

    @Test
    fun `HormuudEVoucherParser's own English 'transferred to' wording does not falsely match this Somali parser`() {
        // The two Hormuud-740 parsers must never both match the same real
        // message — this pins that HormuudEVoucherPayoutSentParser only
        // recognizes the Somali "ayaad uwareejisay" wording, not
        // HormuudEVoucherParser's separate English format.
        assertNull(
            HormuudEVoucherPayoutSentParser.tryParse(
                "740",
                "[-E-Voucher-] You have transferred \$0.1 to 252619991299. Your balance is \$0.27.",
            )
        )
    }

    @Test
    fun `this Somali wording does not falsely match HormuudEVoucherParser's English-only pattern`() {
        // The inverse of the above — confirms the two parsers really are
        // mutually exclusive on real message shapes, not just this one
        // direction.
        assertNull(HormuudEVoucherParser.tryParse("740", realWdr220317059Body))
    }

    @Test
    fun `registered in ExchangePayoutSentParsers so SmsReceiver actually reaches it`() {
        val entry = ExchangePayoutSentParsers.parse("740", realWdr220317059Body)
        requireNotNull(entry) { "HormuudEVoucherPayoutSentParser must be registered in ExchangePayoutSentParsers.ALL" }
        assertEquals("Hormuud", entry.provider)
        assertEquals(1.05, entry.amount, 0.0001)
        assertEquals("617080008", entry.receiverPhone)
    }
}

/**
 * Regression coverage for Hormuud E-Voucher's THIRD real confirmation
 * wording — see HormuudEVoucherSomaliParser's doc comment: this format
 * (Somali "ugu shubtay", a plain Internet Store top-up, no person name)
 * went completely unparsed (sms_receiver_unrecognized, Diagnostics) for a
 * real in_progress Store order despite the direct USSD dial response
 * already reporting SUCCESS for that same order — the corroboration
 * safety net simply had nothing to catch it with for the next order this
 * happens to for real.
 */
class HormuudEVoucherSomaliParserTest {

    // The exact real SMS captured live in Diagnostics, unaltered.
    private val realCapturedBody =
        "[-E-Voucher-] Waxaad \$0.1 ugu shubtay 252619991299, Haraagaagu waa \$0.51.\nLa soo deg App-ka WAAFI http://onelink.to/waafi"

    @Test
    fun `sender 740 is recognized`() {
        assertEquals(listOf("740"), HormuudEVoucherSomaliParser.senders)
    }

    @Test
    fun `the real captured confirmation SMS parses correctly end to end`() {
        val entry = HormuudEVoucherSomaliParser.tryParse("740", realCapturedBody)
        requireNotNull(entry) { "Expected the real captured SMS to parse — it did not." }
        assertEquals("Hormuud", entry.provider)
        assertEquals(0.1, entry.amount, 0.0001)
        assertEquals("252619991299", entry.receiverPhone)
    }

    @Test
    fun `a whole-dollar amount with no decimal point is still parsed correctly`() {
        val entry = HormuudEVoucherSomaliParser.tryParse(
            "740",
            "[-E-Voucher-] Waxaad \$1 ugu shubtay 252619991299, Haraagaagu waa \$0.51.\nLa soo deg App-ka WAAFI http://onelink.to/waafi",
        )
        assertEquals(1.0, entry?.amount ?: -1.0, 0.0001)
    }

    @Test
    fun `a wrong sender is rejected even with matching wording`() {
        assertNull(HormuudEVoucherSomaliParser.tryParse("192", realCapturedBody))
    }

    @Test
    fun `an unrelated SMS from sender 740 is rejected`() {
        assertNull(HormuudEVoucherSomaliParser.tryParse("740", "Your OTP code is 1234"))
    }

    @Test
    fun `the two other Hormuud-740 parsers never also match this Somali 'ugu shubtay' wording`() {
        // All three sender-740 parsers must be mutually exclusive on real
        // message shapes -- confirms this one didn't accidentally start
        // overlapping the English "transferred...to..." or the Somali
        // "ayaad uwareejisay NAME(PHONE)" (a transfer to a named person)
        // formats.
        assertNull(HormuudEVoucherParser.tryParse("740", realCapturedBody))
        assertNull(HormuudEVoucherPayoutSentParser.tryParse("740", realCapturedBody))
    }

    @Test
    fun `this wording does not falsely match the other two Hormuud-740 parsers' own real samples`() {
        val englishBody = "[-E-Voucher-] You have transferred \$0.1 to 252619991299. Your balance is \$0.27."
        val namedTransferBody =
            "[-E-Voucher-] \$1.05 ayaad uwareejisay YAASIIN MAXAMED AADAN(617080008), Haraagaagu waa \$2.27.\nLa soo deg App-ka WAAFI http://onelink.to/waafi"
        assertNull(HormuudEVoucherSomaliParser.tryParse("740", englishBody))
        assertNull(HormuudEVoucherSomaliParser.tryParse("740", namedTransferBody))
    }

    @Test
    fun `registered in VoucherSentParsers so SmsReceiver actually reaches it`() {
        val entry = VoucherSentParsers.parse("740", realCapturedBody)
        requireNotNull(entry) { "HormuudEVoucherSomaliParser must be registered in VoucherSentParsers.ALL" }
        assertEquals("Hormuud", entry.provider)
        assertEquals(0.1, entry.amount, 0.0001)
        assertEquals("252619991299", entry.receiverPhone)
    }
}

/**
 * Regression coverage for Somtel eDahab's second real outgoing-transfer
 * wording — see SomtelWareejisayPayoutSentParser's doc comment: this exact
 * format went completely unparsed for a real, successfully-paid Reseller
 * Withdraw eDahab payout (WDR569919272, 2026-08-19) — the dial automation
 * correctly typed every reply but the on-screen result was AMBIGUOUS (no
 * final confirmation within budget), and the real confirming SMS that
 * arrived seconds later matched neither this app's existing Somtel parser
 * (different wording entirely) nor any sender it recognized.
 */
class SomtelWareejisayPayoutSentParserTest {

    // The exact real SMS that confirmed WDR569919272's payout — captured
    // live, unaltered.
    private val realWdr569919272Body = "Waxaad ku wareejisay 1.2000 Dollars macmiilka 629309509."

    @Test
    fun `sender 252888 is recognized`() {
        assertEquals(listOf("252888"), SomtelWareejisayPayoutSentParser.senders)
    }

    @Test
    fun `the real WDR569919272 confirmation SMS parses correctly end to end`() {
        val entry = SomtelWareejisayPayoutSentParser.tryParse("252888", realWdr569919272Body)
        requireNotNull(entry) { "Expected the real captured SMS to parse — it did not." }
        assertEquals("Somtel", entry.provider)
        assertEquals(1.20, entry.amount, 0.0001)
        assertEquals("629309509", entry.receiverPhone)
    }

    @Test
    fun `a whole-dollar amount with no decimal point is still parsed correctly`() {
        val entry = SomtelWareejisayPayoutSentParser.tryParse("252888", "Waxaad ku wareejisay 5 Dollars macmiilka 620338686.")
        assertEquals(5.0, entry?.amount ?: -1.0, 0.0001)
    }

    @Test
    fun `a wrong sender is rejected even with matching wording`() {
        assertNull(SomtelWareejisayPayoutSentParser.tryParse("eDahab", realWdr569919272Body))
    }

    @Test
    fun `an unrelated SMS from sender 252888 is rejected`() {
        assertNull(SomtelWareejisayPayoutSentParser.tryParse("252888", "Macaamiil promotion kaaga bilaash ka ah."))
    }

    @Test
    fun `SomtelEdahabPayoutSentParser's different wording does not falsely match this parser, and vice versa`() {
        // The two Somtel outgoing parsers must never both match the same
        // real message — confirms they're genuinely mutually exclusive on
        // real message shapes.
        val otherWording = "1.98 Dollar ayad u warejisay Yaasiin Maxamed Aadan. No: 620346060.Tixrac: PP260808.2240.E07703 Haraaga: 7.08 Dollar Kharashyada Adeegga:0"
        assertNull(SomtelWareejisayPayoutSentParser.tryParse("eDahab", otherWording))
        assertNull(SomtelEdahabPayoutSentParser.tryParse("252888", realWdr569919272Body))
    }

    @Test
    fun `registered in ExchangePayoutSentParsers so SmsReceiver actually reaches it`() {
        val entry = ExchangePayoutSentParsers.parse("252888", realWdr569919272Body)
        requireNotNull(entry) { "SomtelWareejisayPayoutSentParser must be registered in ExchangePayoutSentParsers.ALL" }
        assertEquals("Somtel", entry.provider)
        assertEquals(1.20, entry.amount, 0.0001)
        assertEquals("629309509", entry.receiverPhone)
    }
}
