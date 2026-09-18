package com.dalab.internet.ussd

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Source-level guard for requirement "no two USSD sessions may ever dial
 * simultaneously through the same Mobile/SIM": every orchestrator that can
 * trigger a real USSD dial on this device — one-shot
 * (TelephonyManager.sendUssdRequest(), no visible dialog) or interactive
 * (ACTION_CALL + the on-screen "USSD message" reply dialog, read by an
 * AccessibilityService) — must acquire [UssdSimLock] for the SIM slot it's
 * about to dial on before doing so.
 *
 * This replaces a prior, narrower guard (UssdOrchestratorIndependenceTest)
 * that asserted the OPPOSITE for Internet Store specifically — reasoning
 * that since its one-shot dial shows no visible dialog, it "cannot collide
 * with anything on screen" the way eBadal/Reseller Withdraw's interactive
 * flows could collide with EACH OTHER. That reasoning was incomplete: two
 * USSD sessions on the SAME physical SIM can still collide at the
 * carrier/modem level regardless of which Android API triggered either one
 * — the carrier's own USSD session is per-SIM, not per-API. A behavioral
 * test can't prove a dependency was never added (or omitted); reading the
 * actual source can.
 */
class UssdSimLockWiringTest {

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
    fun `every USSD-dialing orchestrator acquires and releases UssdSimLock`() {
        // The inverse of the old (now-removed) independence test: confirms
        // this suite would actually fail if someone dialed on any of these
        // paths without going through the shared per-SIM lock, rather than
        // only ever passing trivially.
        val dialingOrchestrators = listOf(
            "UssdOrchestrator.kt",                              // Internet Store, one-shot
            "ResellerWithdrawalUssdOrchestrator.kt",            // Reseller Withdraw, one-shot
            "ExchangeUssdOrchestrator.kt",                      // Money Exchange payout, interactive
            "ResellerWithdrawalInteractiveUssdOrchestrator.kt", // Reseller Withdraw, interactive
            "WalletLookupUssdOrchestrator.kt",                  // Wallet Name Lookup, interactive, read-only
        )
        for (fileName in dialingOrchestrators) {
            val source = readSource(fileName)
            assertTrue("$fileName must acquire UssdSimLock before dialing", source.contains("UssdSimLock.acquire"))
            assertTrue("$fileName must release UssdSimLock after its dial attempt ends, on every path", source.contains("UssdSimLock.release"))
        }
    }

    @Test
    fun `no orchestrator still references the old, removed device-wide queue`() {
        val dialingOrchestrators = listOf(
            "UssdOrchestrator.kt",
            "ResellerWithdrawalUssdOrchestrator.kt",
            "ExchangeUssdOrchestrator.kt",
            "ResellerWithdrawalInteractiveUssdOrchestrator.kt",
            "WalletLookupUssdOrchestrator.kt",
        )
        for (fileName in dialingOrchestrators) {
            assertFalse(
                "$fileName must not reference the old InteractiveUssdSessionQueue (renamed/generalized to UssdSimLock)",
                readSource(fileName).contains("InteractiveUssdSessionQueue"),
            )
        }
    }
}
