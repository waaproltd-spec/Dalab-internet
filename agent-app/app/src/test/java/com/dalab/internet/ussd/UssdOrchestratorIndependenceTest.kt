package com.dalab.internet.ussd

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Source-level guard for requirement "Internet must remain fast and
 * independent": Internet Store's UssdDialer/UssdOrchestrator drive
 * TelephonyManager.sendUssdRequest() directly with no visible dialog and no
 * AccessibilityService involvement, so — unlike eBadal and Reseller
 * Withdraw's interactive flows — they cannot collide with anything on
 * screen and must never be made to wait on InteractiveUssdSessionQueue.
 * A behavioral test can't prove a dependency was never added; reading the
 * actual source can.
 */
class UssdOrchestratorIndependenceTest {

    private fun readSource(fileName: String): String {
        val candidates = listOf(
            File("src/main/java/com/dalab/internet/ussd/$fileName"),
            File("agent-app/app/src/main/java/com/dalab/internet/ussd/$fileName"),
        )
        val file = candidates.firstOrNull { it.exists() }
            ?: error("Could not locate $fileName from working dir ${File(".").absolutePath} — tried $candidates")
        return file.readText()
    }

    @Test
    fun `UssdOrchestrator (Internet Store) never references the shared interactive USSD session queue`() {
        val source = readSource("UssdOrchestrator.kt")
        assertFalse(
            "Internet Store must stay fast/independent — it must never be wired into InteractiveUssdSessionQueue",
            source.contains("InteractiveUssdSessionQueue"),
        )
    }

    @Test
    fun `UssdDialer (Internet Store) never references the shared interactive USSD session queue`() {
        val source = readSource("UssdDialer.kt")
        assertFalse(
            "Internet Store must stay fast/independent — it must never be wired into InteractiveUssdSessionQueue",
            source.contains("InteractiveUssdSessionQueue"),
        )
    }

    @Test
    fun `both interactive flows (eBadal and Reseller Withdraw) are actually wired into the shared queue`() {
        // The inverse check -- confirms this suite would actually fail if
        // someone removed the wiring added in ExchangeUssdOrchestrator /
        // ResellerWithdrawalInteractiveUssdOrchestrator, rather than only
        // ever passing trivially.
        assertTrue(readSource("ExchangeUssdOrchestrator.kt").contains("InteractiveUssdSessionQueue.acquire"))
        assertTrue(readSource("ResellerWithdrawalInteractiveUssdOrchestrator.kt").contains("InteractiveUssdSessionQueue.acquire"))
    }
}
