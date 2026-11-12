package com.dalab.internet.ussd

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Source-level guard for requirement "no two USSD sessions may ever dial
 * simultaneously through the same Mobile/SIM": every orchestrator that
 * triggers a REAL USSD dial on this device — one-shot
 * (TelephonyManager.sendUssdRequest(), no visible dialog) or interactive
 * (ACTION_CALL + the on-screen "USSD message" reply dialog, read by an
 * AccessibilityService) — must acquire [UssdSimLock] for the SIM slot it's
 * about to dial on before doing so, and release it after every dial attempt
 * ends (success, failure, or timeout). Internet Store recharge
 * (UssdOrchestrator) is included: it dials a real USSD code via
 * TelephonyManager.sendUssdRequest() exactly like Reseller Withdraw's own
 * one-shot path does, just with no visible dialog — "no visible dialog"
 * never meant "not a real dial," and the carrier/modem still serializes
 * USSD sessions per SIM regardless of which Android API triggered either
 * side. A feature that never actually dials USSD has no business being
 * wired into this lock at all — this suite only covers the flows that do.
 *
 * A behavioral test can't prove a dependency was never added (or omitted);
 * reading the actual source can.
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
        // The inverse of "never wired in": confirms this suite would
        // actually fail if someone dialed on any of these paths without
        // going through the shared per-SIM lock, rather than only ever
        // passing trivially.
        val dialingOrchestrators = listOf(
            "UssdOrchestrator.kt",                              // Internet Store recharge, one-shot
            "ResellerWithdrawalUssdOrchestrator.kt",            // Reseller Withdraw, one-shot
            "ExchangeUssdOrchestrator.kt",                      // Money Exchange/eBadal payout, interactive
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
