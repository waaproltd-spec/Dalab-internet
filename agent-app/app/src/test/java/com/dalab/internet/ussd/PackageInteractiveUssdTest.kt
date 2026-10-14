package com.dalab.internet.ussd

import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Somtel Dhameys Plus menu delivery: the screen checks the runner makes
 * before every reply, and the final classification -- using the real
 * Somtel screens captured on 2026-10-14 (*101# -> 4 -> 3 -> 2 -> number ->
 * eDahab PIN).
 */
class PackageInteractiveUssdTest {
    private val mainMenu = "<-Somtel Services- >\n1. Ku Hadal\n2. Kaafiye Plus\n3. Jumca & Abaal\n4. Dhameys Plus\n5. Muraadso\n6. Broadband & DID"
    private val packageMenu = "<-Dhameys Plus- >\n1. \$0.2 = 6 hrs\n2. \$0.35 =12 hrs\n3. \$0.5 = Daily 24 Hrs\n4. \$1 = 48 Hrs\n5. \$3.4 = 7-days\n6. \$7.5 15 Days\n7. \$15 = Monthly Plus\n0. Back"
    private val forWhom = "<-Dhameys Plus- >\nDooro:\n1. Ku Shubo\n2. Ugu Shub Qof Kale\n0. Back"
    private val numberPrompt = "<-Dhameys Plus- >\nGeli lambarka taleefanka aad u furayso = Daily 24 Hrs\n0. Back"
    private val pinPrompt = "<-Dhameys Plus- >\nMa hubtaa inaad = Daily 24 Hrs oo ah \$0.50 u furto lambarka 620346060?\nGeli PIN-kaaga eDahab\n\n0. Back"
    private val receipt = "Macmiil, waxaad ku guuleysatay inaad = Daily 24 Hrs ugu shubto 620346060.\nWaad ku mahadsantahay isticmaalka adeegyada Somtel!"

    // Exactly what the backend renders for the Daily package (see the
    // backend's dhameysPlus.test.ts), parsed the way Retrofit/Gson does.
    private val dailyPlanJson = """
        {"version":1,"initialDial":"*101#","successKeywords":["guuleysatay","guulaysatay","ugu shubto"],
         "steps":[
          {"reply":"4","expect":["Dhameys"]},
          {"reply":"3","expect":["Dhameys"],"menuOption":{"option":"3","amount":"0.50"}},
          {"reply":"2","expect":["Qof Kale"]},
          {"reply":"620346060","expect":["lambarka"]},
          {"reply":"{pin}","expect":["PIN"],"amount":"0.50","number":"620346060","secret":true}
         ]}
    """.trimIndent()
    private val plan: UssdPlan = Gson().fromJson(dailyPlanJson, UssdPlan::class.java)

    @Test
    fun `the backend plan parses and is valid`() {
        assertNull(planProblem(plan))
        assertEquals("*101#", plan.initialDial)
        assertEquals(listOf("4", "3", "2", "620346060", "{pin}"), plan.steps.map { it.reply })
        assertTrue(plan.steps.last().secret)
    }

    @Test
    fun `every real Somtel screen matches its step`() {
        val screens = listOf(mainMenu, packageMenu, forWhom, numberPrompt, pinPrompt)
        plan.steps.zip(screens).forEachIndexed { i, (step, screen) ->
            assertNull("step ${i + 1}", screenMismatch(step, screen))
        }
    }

    @Test
    fun `menu prices are read per option, including whole dollars and two digits`() {
        assertEquals(0.2, menuOptionPrice(packageMenu, "1")!!, 0.0001)
        assertEquals(0.35, menuOptionPrice(packageMenu, "2")!!, 0.0001)
        assertEquals(0.5, menuOptionPrice(packageMenu, "3")!!, 0.0001)
        assertEquals(1.0, menuOptionPrice(packageMenu, "4")!!, 0.0001)
        assertEquals(3.4, menuOptionPrice(packageMenu, "5")!!, 0.0001)
        assertEquals(7.5, menuOptionPrice(packageMenu, "6")!!, 0.0001)
        assertEquals(15.0, menuOptionPrice(packageMenu, "7")!!, 0.0001)
        assertNull(menuOptionPrice(packageMenu, "8"))
    }

    @Test
    fun `a reordered or repriced Somtel menu stops before the PIN`() {
        val step = plan.steps[1]
        val reordered = packageMenu.replace("3. \$0.5 = Daily 24 Hrs", "3. \$1 = 48 Hrs")
        val reason = screenMismatch(step, reordered)
        assertNotNull(reason)
        assertTrue(reason!!, reason.contains("menu may have changed"))
        assertNotNull(screenMismatch(step, packageMenu.replace("3. \$0.5", "3. \$0.55")))
        assertNotNull("option missing", screenMismatch(step, packageMenu.replace("3. \$0.5 = Daily 24 Hrs\n", "")))
    }

    @Test
    fun `the PIN is never sent unless the confirmation shows the right amount and number`() {
        val pinStep = plan.steps.last()
        assertNotNull(screenMismatch(pinStep, pinPrompt.replace("\$0.50", "\$1.00")))
        assertNotNull(screenMismatch(pinStep, pinPrompt.replace("620346060", "620346061")))
        assertNotNull(screenMismatch(pinStep, "Haraaga xisaabtaadu kuguma filna"))
        assertNull(screenMismatch(pinStep, pinPrompt.replace("\$0.50", "0.5\$")))
    }

    @Test
    fun `an unexpected screen at any step is a mismatch`() {
        assertNotNull(screenMismatch(plan.steps[0], "Invalid MMI code"))
        assertNotNull(screenMismatch(plan.steps[2], packageMenu))
        assertNotNull(screenMismatch(plan.steps[3], forWhom))
    }

    @Test
    fun `Somtel's real receipt is success, failures are failed, anything else is never success`() {
        assertEquals(DialOutcome.SUCCESS, classifyPackageMenuResponse(receipt, plan.successKeywords.orEmpty()))
        assertEquals(DialOutcome.SUCCESS, classifyPackageMenuResponse(receipt))
        assertEquals(DialOutcome.FAILED, classifyPackageMenuResponse("Haraaga xisaabtaadu kuguma filna, haraagaagu waa: 0.10"))
        assertEquals(DialOutcome.FAILED, classifyPackageMenuResponse("PIN-ka aad gelisay waa khalad"))
        assertEquals(DialOutcome.FAILED, classifyPackageMenuResponse("Sorry, try again later"))
        assertEquals(DialOutcome.AMBIGUOUS, classifyPackageMenuResponse("Codsigaaga waa la helay"))
        assertEquals(DialOutcome.AMBIGUOUS, classifyPackageMenuResponse(""))
        assertEquals(DialOutcome.AMBIGUOUS, classifyPackageMenuResponse(null))
    }

    @Test
    fun `an unsafe plan from the server is refused before dialing`() {
        assertNotNull(planProblem(plan.copy(initialDial = "101")))
        assertNotNull(planProblem(plan.copy(steps = plan.steps.dropLast(1))))
        assertNotNull(planProblem(plan.copy(steps = listOf(plan.steps.last()) + plan.steps.dropLast(1))))
        assertNotNull(planProblem(plan.copy(steps = plan.steps.dropLast(1) + plan.steps.last().copy(amount = null))))
    }

    @Test
    fun `dollar amounts are read in both carrier styles`() {
        assertEquals(listOf(0.5), dollarAmountsIn("oo ah \$0.50 u furto"))
        assertEquals(listOf(15.0), dollarAmountsIn("15\$ Monthly"))
    }
}
