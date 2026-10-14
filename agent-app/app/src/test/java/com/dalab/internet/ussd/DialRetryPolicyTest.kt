package com.dalab.internet.ussd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Money must never be sent twice by automation: a one-shot dial string
 * carries the PIN, so any outcome that might mean "it went through" is never
 * retried automatically (the server also refuses a new dial while an earlier
 * one's result is unknown -- see dialSafety tests in admin-backend-ts).
 */
class DialRetryPolicyTest {
    @Test fun `a confirmed failure is retried`() {
        assertTrue(isAutomaticallyRetryable(DialResult(DialOutcome.FAILED, "USSD failure code: -1")))
    }

    @Test fun `a timeout is never retried automatically - the carrier may have taken the money`() {
        assertFalse(isAutomaticallyRetryable(DialResult(DialOutcome.TIMEOUT, "No response in 30s")))
    }

    @Test fun `an unclear reply is never retried automatically`() {
        assertFalse(isAutomaticallyRetryable(DialResult(DialOutcome.AMBIGUOUS, "Connection problem or invalid MMI code.")))
    }

    @Test fun `a failure marked noRetry (menu mismatch or PIN already sent) is never retried`() {
        assertFalse(isAutomaticallyRetryable(DialResult(DialOutcome.FAILED, "Screen didn't match", noRetry = true)))
    }

    @Test fun `setup problems and success are never retried`() {
        for (o in listOf(DialOutcome.SUCCESS, DialOutcome.NO_SIM_PRESENT, DialOutcome.NO_SIM_CONFIGURED, DialOutcome.PERMISSION_DENIED, DialOutcome.DUPLICATE_SKIPPED)) {
            assertFalse(o.name, isAutomaticallyRetryable(DialResult(o, null)))
        }
    }

    @Test fun `Somtel's -ey- spelling and ugu shubto read as success`() {
        assertEquals(
            DialOutcome.SUCCESS,
            classifyRechargeUssdResponse("Macmiil, waxaad ku guuleysatay inaad = Daily 24 Hrs ugu shubto 620346060. Waad ku mahadsantahay isticmaalka adeegyada Somtel!"),
        )
    }

    @Test fun `negated success wording is a failure, never success`() {
        assertEquals(DialOutcome.FAILED, classifyRechargeUssdResponse("Your request has not been transferred."))
        assertEquals(DialOutcome.FAILED, classifyRechargeUssdResponse("Amount not transferred to 711338686"))
        assertEquals(DialOutcome.FAILED, classifyRechargeUssdResponse("Macmiil, kumaad guuleysan inaad ugu shubto 620346060"))
    }

    @Test fun `unknown text stays ambiguous`() {
        assertEquals(DialOutcome.AMBIGUOUS, classifyRechargeUssdResponse("Please wait"))
    }
}
