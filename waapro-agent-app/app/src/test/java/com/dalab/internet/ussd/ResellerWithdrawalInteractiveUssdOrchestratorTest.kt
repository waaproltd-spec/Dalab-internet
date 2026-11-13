package com.dalab.internet.ussd

import com.dalab.internet.data.ResellerWithdrawalInteractivePayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Pure JVM unit tests for the eDahab-style interactive payout's pure logic
 * (buildResellerWithdrawalInteractiveReplies/formatPlainAmount/auditUssdString
 * — no Android/Context dependency, so no instrumentation or emulator is
 * needed). The actual on-device dialog-driving behavior in
 * ResellerWithdrawalInteractiveUssdAccessibilityService/
 * ResellerWithdrawalInteractiveUssdBridge cannot be exercised this way —
 * this only pins down what gets typed, in what order, and what leaves the
 * device (never the PIN).
 */
class ResellerWithdrawalInteractiveUssdOrchestratorTest {

    // The real eDahab reply sequence from the captured production screenshots:
    // dial *300# -> "3" selects Transfer -> destination number -> amount ->
    // (carrier then prompts for the PIN, appended automatically, never
    // configured inline here).
    private val edahabReplySteps = listOf("3", "{number}", "{amount}")

    @Test
    fun `builds the exact real eDahab reply sequence with the PIN appended last`() {
        val replies = buildResellerWithdrawalInteractiveReplies(edahabReplySteps, "620338686", 10.00, "8233")
        assertEquals(listOf("3", "620338686", "10.00", "8233"), replies)
    }

    @Test
    fun `1 dollar 5 cents formats as a plain decimal, unlike Hormuud's split-token format`() {
        assertEquals("1.05", formatPlainAmount(1.05))
    }

    @Test
    fun `floating point drift near a cent boundary still rounds to the correct cent`() {
        assertEquals("5.37", formatPlainAmount(5.37))
        assertEquals("0.01", formatPlainAmount(0.01))
        assertEquals("0.09", formatPlainAmount(0.09))
    }

    @Test
    fun `a company whose reply steps repeat a placeholder still substitutes every occurrence`() {
        val replies = buildResellerWithdrawalInteractiveReplies(listOf("{amount} to {number}"), "620338686", 2.50, "1111")
        assertEquals(listOf("2.50 to 620338686", "1111"), replies)
    }

    @Test
    fun `a literal reply step with no placeholder passes through unchanged`() {
        val replies = buildResellerWithdrawalInteractiveReplies(listOf("3"), "620338686", 2.50, "1111")
        assertEquals("3", replies[0])
    }

    @Test
    fun `the audit string never contains the real PIN`() {
        val payout = ResellerWithdrawalInteractivePayout("*300#", edahabReplySteps, pin = "8233")
        val audit = auditUssdString(payout)
        assertFalse("audit string leaked the real PIN: \"$audit\"", audit.contains("8233"))
        assertEquals("*300# -> 3 -> {number} -> {amount} -> [PIN]", audit)
    }

    @Test
    fun `an empty reply steps list still ends with exactly the PIN`() {
        val replies = buildResellerWithdrawalInteractiveReplies(emptyList(), "620338686", 5.00, "9999")
        assertEquals(listOf("9999"), replies)
    }

    // The real Somnet reply sequence: dial *825# -> PIN first -> "2" selects
    // Money Transfer -> destination number -> confirm the same number again
    // -> amount -> "1" confirms Yes. The PIN is the very first reply here,
    // not the last -- the opposite of eDahab's flow above.
    private val somnetReplySteps = listOf("{pin}", "2", "{number}", "{number}", "{amount}", "1")

    @Test
    fun `builds the exact real Somnet reply sequence with the PIN placed first, not appended last`() {
        val replies = buildResellerWithdrawalInteractiveReplies(somnetReplySteps, "712345678", 50.00, "8233")
        assertEquals(listOf("8233", "2", "712345678", "712345678", "50.00", "1"), replies)
    }

    @Test
    fun `a pin token in the middle of the sequence is substituted only there`() {
        val replies = buildResellerWithdrawalInteractiveReplies(listOf("3", "{pin}", "{number}"), "620338686", 2.50, "1111")
        assertEquals(listOf("3", "1111", "620338686"), replies)
    }

    @Test
    fun `the audit string masks an inline pin token at its real position instead of appending it`() {
        val payout = ResellerWithdrawalInteractivePayout("*825#", somnetReplySteps, pin = "8233")
        val audit = auditUssdString(payout)
        assertFalse("audit string leaked the real PIN: \"$audit\"", audit.contains("8233"))
        assertEquals("*825# -> [PIN] -> 2 -> {number} -> {number} -> {amount} -> 1", audit)
    }
}
