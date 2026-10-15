package com.dalab.internet.ussd

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * An order is dialed only on the phone + SIM the Admin assigned: its
 * template pin, else this phone's primary SIM Routing entry. Never on
 * another phone's order, never on the other SIM. Mirrors the server's
 * utils/orderRouting.ts (simRoutingAssignment.test.ts).
 */
class AssignedSimTest {
    private val mobile1 = "mobile-1"
    private val mobile2 = "mobile-2"

    @Test fun `an Amtel order routed to Mobile 2 SIM 2 dials on SIM 2 there`() {
        assertEquals(AssignedSim.ThisPhone(2), resolveAssignedSim(null, null, mobile2, SimSlotResult.Slot(2)))
    }

    @Test fun `Mobile 1 is not routed for Amtel so it never dials that order`() {
        // The server only sends a phone the companies it is PRIMARY for:
        // Mobile 1 being Amtel's backup gives it no Amtel route at all.
        assertEquals(AssignedSim.NotConfigured, resolveAssignedSim(null, null, mobile1, SimSlotResult.NotConfigured))
    }

    @Test fun `a template pinned to another phone is never dialed here on this phone's own routing`() {
        // Previously this fell back to this phone's routing for the company.
        assertEquals(
            AssignedSim.OtherPhone(mobile2, 2),
            resolveAssignedSim(mobile2, 2, mobile1, SimSlotResult.Slot(1)),
        )
    }

    @Test fun `a template pinned to this phone uses exactly the pinned SIM`() {
        assertEquals(AssignedSim.ThisPhone(1), resolveAssignedSim(mobile2, 1, mobile2, SimSlotResult.Slot(2)))
    }

    @Test fun `a phone with no device id never takes a pinned order`() {
        assertEquals(AssignedSim.OtherPhone(mobile2, 2), resolveAssignedSim(mobile2, 2, null, SimSlotResult.NotConfigured))
    }

    @Test fun `a routing cache that failed to load waits instead of guessing a SIM`() {
        assertEquals(AssignedSim.LoadFailed, resolveAssignedSim(null, null, mobile2, SimSlotResult.LoadFailed))
    }

    @Test fun `a timeout is reported as result unknown, never as failed`() {
        assertEquals("ambiguous", reportedDialStatus(DialResult(DialOutcome.TIMEOUT)))
        assertEquals("ambiguous", reportedDialStatus(DialResult(DialOutcome.AMBIGUOUS, "unclear")))
    }

    @Test fun `a menu timeout before the PIN, when nothing was paid, is a plain failure`() {
        assertEquals("failed", reportedDialStatus(DialResult(DialOutcome.TIMEOUT, "No response from the carrier at step 1 of 5", moneyNotSent = true)))
    }

    @Test fun `success and real failures are reported as they are`() {
        assertEquals("success", reportedDialStatus(DialResult(DialOutcome.SUCCESS, "ok")))
        assertEquals("failed", reportedDialStatus(DialResult(DialOutcome.FAILED, "Insufficient balance")))
    }

    @Test fun `a timeout is never retried automatically`() {
        assertEquals(false, isAutomaticallyRetryable(DialResult(DialOutcome.TIMEOUT)))
        assertEquals(false, isAutomaticallyRetryable(DialResult(DialOutcome.ASSIGNED_TO_OTHER_SIM)))
    }
}
