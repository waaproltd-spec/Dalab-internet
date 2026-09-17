package com.dalab.internet.ussd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Regression coverage for the Hormuud amount-formatting bugs: {amount} in a
 * payout template must expand to "<dollars>*<cents>" (two separate
 * *-delimited tokens) when both are present, not a plain "%.2f" decimal
 * string like "1.05" — see formatHormuudSplitAmount's doc comment in
 * ResellerWithdrawalUssdOrchestrator.kt for the live-confirmed reasoning (a
 * decimal token got a misleading "insufficient balance" rejection; the
 * split-token form actually sent the money, confirmed by the carrier's own
 * outgoing SMS) — AND a whole-dollar amount must never carry a spurious
 * "*00" cents segment (a second, later-reported live bug: a real EVC Plus
 * whole-dollar dial with the same unconditional-split shape was rejected
 * over that exact extra field).
 *
 * Pure JVM unit tests — formatHormuudSplitAmount/buildResellerWithdrawalUssdString
 * have no Android/Context dependency, so no instrumentation or emulator is
 * needed to run these.
 */
class ResellerWithdrawalUssdOrchestratorTest {

    // The real production Hormuud template — same one used live. The PIN
    // segment ("8233") is never printed by these tests; assertEquals'
    // failure output would include it, which is acceptable for local/CI
    // failure diagnostics (not a log line), but nothing here deliberately
    // logs it.
    private val hormuudTemplate = "*726*{number}*{amount}*8233#"

    @Test
    fun `1 dollar even formats as just the dollar figure, no spurious star-00`() {
        assertEquals("1", formatHormuudSplitAmount(1.00))
    }

    @Test
    fun `1 dollar 5 cents formats as dollars-star-05 — the exact bug case`() {
        assertEquals("1*05", formatHormuudSplitAmount(1.05))
    }

    @Test
    fun `5 dollars 37 cents formats as dollars-star-37`() {
        assertEquals("5*37", formatHormuudSplitAmount(5.37))
    }

    @Test
    fun `10 dollars 50 cents formats as dollars-star-50`() {
        assertEquals("10*50", formatHormuudSplitAmount(10.50))
    }

    @Test
    fun `5 cents with no dollars formats as just the cents figure, no leading zero-star`() {
        assertEquals("05", formatHormuudSplitAmount(0.05))
    }

    @Test
    fun `50 cents with no dollars formats as just the cents figure`() {
        assertEquals("50", formatHormuudSplitAmount(0.50))
    }

    @Test
    fun `42 dollars even produces the exact required USSD command — the real reported bug (previously 42-star-00)`() {
        val ussd = buildResellerWithdrawalUssdString(hormuudTemplate, "617080008", 42.00)
        assertEquals("*726*617080008*42*8233#", ussd)
        assertNotEquals("*726*617080008*42*00*8233#", ussd)
    }

    @Test
    fun `1 dollar even produces the exact required USSD command`() {
        val ussd = buildResellerWithdrawalUssdString(hormuudTemplate, "617080008", 1.00)
        assertEquals("*726*617080008*1*8233#", ussd)
        assertNotEquals("*726*617080008*1*00*8233#", ussd)
    }

    @Test
    fun `1 dollar 5 cents produces the exact required USSD command — the real-world case that was previously broken`() {
        val ussd = buildResellerWithdrawalUssdString(hormuudTemplate, "617080008", 1.05)
        assertEquals("*726*617080008*1*05*8233#", ussd)
        // The old (broken) behavior would have produced this instead —
        // pin the negative case too, so a regression back to decimal
        // formatting fails loudly rather than just failing the positive
        // assertion above.
        assertNotEquals("*726*617080008*1.05*8233#", ussd)
    }

    @Test
    fun `5 dollars 37 cents produces the exact required USSD command`() {
        val ussd = buildResellerWithdrawalUssdString(hormuudTemplate, "617080008", 5.37)
        assertEquals("*726*617080008*5*37*8233#", ussd)
    }

    @Test
    fun `10 dollars 50 cents produces the exact required USSD command`() {
        val ussd = buildResellerWithdrawalUssdString(hormuudTemplate, "617080008", 10.50)
        assertEquals("*726*617080008*10*50*8233#", ussd)
    }

    @Test
    fun `the generated amount token is never a plain decimal string`() {
        for (amount in listOf(1.00, 1.05, 5.37, 10.50, 0.09, 0.05, 0.50, 42.00, 123.45)) {
            val token = formatHormuudSplitAmount(amount)
            assertNotEquals(
                "formatHormuudSplitAmount(\$amount) must never contain a literal '.' — got \"$token\"",
                true,
                token.contains("."),
            )
        }
    }

    @Test
    fun `floating point drift near a cent boundary still rounds to the correct cent`() {
        // 5.37 as a Double is not stored exactly (it's fractionally off in
        // binary) — multiplying by 100 without rounding first can land on
        // 536.999999999... and truncate to the wrong cent. This is the
        // exact failure mode formatHormuudSplitAmount's rounding-first
        // approach guards against.
        assertEquals("5*37", formatHormuudSplitAmount(5.37))
        assertEquals("01", formatHormuudSplitAmount(0.01))
        assertEquals("09", formatHormuudSplitAmount(0.09))
    }
}
