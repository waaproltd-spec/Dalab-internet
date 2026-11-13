package com.dalab.internet.ussd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SimBalanceAlertsTest {

    @Test
    fun insufficientBalanceRefusalStopsTheDialWithTheServerMessage() {
        val message = "Insufficient SIM Balance — Hormuud. The customer requested \$20.00, but the available SIM balance is only \$12.00. The remaining amount needed is \$8.00. Please recharge the Hormuud SIM and try again."
        val result = SimBalanceAlerts.refusalFromJson("insufficient_sim_balance", message)!!
        assertEquals(DialOutcome.INSUFFICIENT_SIM_BALANCE, result.outcome)
        assertEquals(message, result.responseMessage)
    }

    @Test
    fun unknownOrOutdatedBalanceRefusalIsItsOwnOutcome() {
        val result = SimBalanceAlerts.refusalFromJson("sim_balance_unverified", "SIM Balance Unknown — Somnet. The Somnet SIM balance has not been recorded yet.")!!
        assertEquals(DialOutcome.SIM_BALANCE_UNVERIFIED, result.outcome)
    }

    @Test
    fun otherRefusalsAreNotTreatedAsBalanceProblems() {
        assertNull(SimBalanceAlerts.refusalFromJson(null, "This order's payment has already completed."))
        assertNull(SimBalanceAlerts.refusalFromJson("", "x"))
        assertNull(SimBalanceAlerts.refusalFromJson("something_else", "x"))
    }

    @Test
    fun aMissingMessageStillGivesTheAgentAnExplanation() {
        val result = SimBalanceAlerts.refusalFromJson("insufficient_sim_balance", "")!!
        assertEquals(true, result.responseMessage!!.startsWith("Insufficient SIM Balance"))
    }

    @Test
    fun theNotificationTitleNamesTheCompany() {
        val hormuud = SimBalanceAlerts.refusalFromJson(
            "insufficient_sim_balance",
            "Insufficient SIM Balance — Hormuud. The customer requested \$20.00, but the available SIM balance is only \$12.00. The remaining amount needed is \$8.00. Please recharge the Hormuud SIM and try again.",
        )!!
        assertEquals("Insufficient SIM Balance — Hormuud", SimBalanceAlerts.titleFor(hormuud))
        val amtel = SimBalanceAlerts.refusalFromJson("sim_balance_unverified", "SIM Balance Outdated — Amtel. The Amtel SIM showed \$3.00 at its last update.")!!
        assertEquals("SIM Balance Outdated — Amtel", SimBalanceAlerts.titleFor(amtel))
        // An older server's wording without a company still gets a clear title.
        assertEquals("Insufficient SIM Balance", SimBalanceAlerts.titleFor(SimBalanceAlerts.refusalFromJson("insufficient_sim_balance", "")!!))
    }

    @Test
    fun theSameOrderAndProblemAlertsOnlyOnce() {
        val blocked = SimBalanceAlerts.refusalFromJson("insufficient_sim_balance", "Insufficient SIM Balance — Somtel. The remaining amount needed is \$2.00.")!!
        assertTrue(SimBalanceAlerts.shouldAlert("ORDER-A", blocked))
        assertFalse("an automatic retry hitting the same refusal stays silent", SimBalanceAlerts.shouldAlert("ORDER-A", blocked))
        assertTrue("another order is its own alert", SimBalanceAlerts.shouldAlert("ORDER-B", blocked))

        val worse = SimBalanceAlerts.refusalFromJson("insufficient_sim_balance", "Insufficient SIM Balance — Somtel. The remaining amount needed is \$5.00.")!!
        assertTrue("a different problem for the same order alerts again", SimBalanceAlerts.shouldAlert("ORDER-A", worse))

        SimBalanceAlerts.clear("ORDER-A")
        assertTrue("after the order got past the check, a new refusal alerts again", SimBalanceAlerts.shouldAlert("ORDER-A", worse))
    }
}
