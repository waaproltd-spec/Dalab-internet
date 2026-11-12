package com.dalab.internet.ussd

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression coverage for looksLikeConfirmedExchangePayout — the fail-closed
 * classifier for Money Exchange's final USSD payout confirmation.
 *
 * Written against a 2026-08-31 production-safety audit: querying this app's
 * own live exchange_dial_attempts rows recorded with status='success' found
 * two that were not transfer confirmations at all (a device accessibility-
 * service diagnostic string, and static rate/fee help text), misclassified
 * by the previous `!looksLikeFailureResponse(text)` design, which treated
 * ANY response not matching a failure keyword as a completed real-money
 * payout. Every case below (both the real confirmations and the two real
 * misclassified rows) is the exact text captured from that query, not
 * invented.
 *
 * Pure JVM unit test — no Android/Context dependency.
 */
class ExchangePayoutClassifierTest {

    // ---------------- Real captured genuine confirmations ----------------

    @Test
    fun `real EVC Plus transfer confirmation is a confirmed payout`() {
        assertTrue(
            looksLikeConfirmedExchangePayout(
                "[-EVCPLUS-] \$0.99 ayaad uwareejisay MAHAD YAASIIN MAXAMED(619991299), Tar: 25/08/26 18:09:10, Haraagaagu waa \$0.725.\nLa soo deg App-ka WAAFI http://onelink.to/waafi\nSIM 1"
            ),
        )
    }

    @Test
    fun `real eDahab transfer confirmation is a confirmed payout`() {
        assertTrue(
            looksLikeConfirmedExchangePayout(
                "1.98 Dollar ayad u warejisay Yaasiin Maxamed Aadan. No: 620346060.Tixrac: PP260814.1137.E48452 Haraaga: 0.07 Dollar Kharashyada Adeegga:0 Dollar Tariikh:14-08-2026[-eDahab-Service-]"
            ),
        )
    }

    // ---------------- Real rows misclassified SUCCESS in production before this fix ----------------

    @Test
    fun `a device accessibility-service diagnostic string is never a confirmed payout`() {
        // Real production row, captured with status='success' before this fix.
        // Describes Android's accessibility service losing the USSD window
        // -- the literal opposite of a successful automated payout.
        assertFalse(
            looksLikeConfirmedExchangePayout(
                "Laakiin Samsung/Android ayaa Accessibility Service-ka ka joojiyay inuu arko USSD window-ka markii window-ku lumiyay foreground status."
            ),
        )
    }

    @Test
    fun `static rate-and-fee help text is never a confirmed payout`() {
        // Real production row, captured with status='success' before this
        // fix -- generic in-app help text, not a carrier response at all.
        assertFalse(
            looksLikeConfirmedExchangePayout(
                "Rate and fee for converting from one wallet to another. Amount received = amount sent × rate − fee."
            ),
        )
    }

    // ---------------- Fail-closed contract: unknown/empty text is NEVER a confirmed payout ----------------

    @Test
    fun `an unrelated but plausible-looking response is never a confirmed payout`() {
        assertFalse(looksLikeConfirmedExchangePayout("Thank you for your business."))
        assertFalse(looksLikeConfirmedExchangePayout("Your request is being processed."))
    }

    @Test
    fun `empty or blank response is never a confirmed payout`() {
        assertFalse(looksLikeConfirmedExchangePayout(""))
        assertFalse(looksLikeConfirmedExchangePayout("   "))
    }

    @Test
    fun `is case-insensitive`() {
        assertTrue(looksLikeConfirmedExchangePayout("AYAAD UWAREEJISAY SOMEONE"))
    }
}
