package com.dalab.internet.ussd

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Regression coverage for classifyResellerWithdrawalUssdResponse — see
 * SUCCESS_RESPONSE_KEYWORDS's doc comment in UssdDialer.kt for why each
 * of these phrases is real, confirmed-live wording rather than a guess.
 * Pure JVM unit tests — no Android/Context dependency.
 */
class ResellerWithdrawalUssdResponseClassifierTest {

    @Test
    fun `Hormuud one-shot uwareejisay response is SUCCESS`() {
        assertEquals(
            DialOutcome.SUCCESS,
            classifyResellerWithdrawalUssdResponse(
                "\$1.05 ayaad uwareejisay YASIIN MAXAMED AADAN (610346060), Tar: 09/08/26 20:32:27, Haraagaagu waa \$36.965."
            ),
        )
    }

    @Test
    fun `Somtel eDahab single-e warejisay response is SUCCESS`() {
        assertEquals(
            DialOutcome.SUCCESS,
            classifyResellerWithdrawalUssdResponse("\$1 Dollar ayaad u warejisay 629309509. No: 617080008."),
        )
    }

    @Test
    fun `Somtel eDahab double-e wareejisay response is SUCCESS`() {
        // Previously misclassified AMBIGUOUS -- the SMS-side parser
        // (SomtelWareejisayPayoutSentParser) already recognized this exact
        // spelling as real, confirmed wording, but the on-screen classifier
        // never did, leaving a withdrawal whose carrier confirmation used
        // this spelling stuck at 'sent' after a genuinely successful payout.
        assertEquals(
            DialOutcome.SUCCESS,
            classifyResellerWithdrawalUssdResponse("Waxaad ku wareejisay \$1 Dollars macmiilka 629309509."),
        )
    }

    @Test
    fun `English transferred response is SUCCESS`() {
        assertEquals(DialOutcome.SUCCESS, classifyResellerWithdrawalUssdResponse("You have successfully transferred \$1 to 629309509."))
    }

    @Test
    fun `Somali insufficient-balance response is FAILED, not SUCCESS or AMBIGUOUS`() {
        assertEquals(
            DialOutcome.FAILED,
            classifyResellerWithdrawalUssdResponse("Haraaga xisaabtaadu kuguma filna, haraagaagu waa: 5.367"),
        )
    }

    @Test
    fun `Receiver Account Not Found response is FAILED`() {
        assertEquals(DialOutcome.FAILED, classifyResellerWithdrawalUssdResponse("Receiver Account Not Found"))
    }

    @Test
    fun `an unrecognized response is AMBIGUOUS, never guessed as SUCCESS`() {
        assertEquals(DialOutcome.AMBIGUOUS, classifyResellerWithdrawalUssdResponse("Thank you for using our service."))
    }

    @Test
    fun `empty response is AMBIGUOUS`() {
        assertEquals(DialOutcome.AMBIGUOUS, classifyResellerWithdrawalUssdResponse("   "))
    }
}
