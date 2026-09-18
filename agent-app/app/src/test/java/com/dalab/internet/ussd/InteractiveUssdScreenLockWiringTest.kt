package com.dalab.internet.ussd

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Source-level guard, mirroring [UssdSimLockWiringTest]'s own reasoning:
 * every orchestrator that drives an interactive (AccessibilityService-based,
 * on-screen-dialog) USSD flow must acquire [InteractiveUssdScreenLock] --
 * via its bridge's acquireSession()/releaseSession() delegation -- before
 * arming its bridge and release it after every attempt ends. This is
 * deliberately scoped to the THREE interactive flows only
 * (ExchangeUssdOrchestrator, WalletLookupUssdOrchestrator,
 * ResellerWithdrawalInteractiveUssdOrchestrator) -- the one-shot flows
 * (UssdOrchestrator/Internet Store, ResellerWithdrawalUssdOrchestrator's own
 * one-shot path) never draw a visible dialog and have no accessibility
 * service watching anything, so they have no business touching this lock at
 * all; [UssdSimLock] alone already covers them correctly.
 *
 * A behavioral test can't prove a dependency was never added (or omitted);
 * reading the actual source can.
 */
class InteractiveUssdScreenLockWiringTest {

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
    fun `every interactive USSD orchestrator acquires and releases the shared screen lock`() {
        val interactiveOrchestrators = listOf(
            "ExchangeUssdOrchestrator.kt",                      // Money Exchange/eBadal payout
            "WalletLookupUssdOrchestrator.kt",                  // Wallet Name Lookup, read-only
            "ResellerWithdrawalInteractiveUssdOrchestrator.kt", // Reseller Withdraw, interactive
        )
        for (fileName in interactiveOrchestrators) {
            val source = readSource(fileName)
            assertTrue("$fileName must acquire the shared session/screen lock before arming its bridge", source.contains("acquireSession()"))
            assertTrue("$fileName must release the shared session/screen lock after its attempt ends, on every path", source.contains("releaseSession()"))
        }
    }

    @Test
    fun `the one-shot, non-interactive flows never touch the interactive screen lock`() {
        val oneShotOrchestrators = listOf(
            "UssdOrchestrator.kt",                   // Internet Store recharge, one-shot
            "ResellerWithdrawalUssdOrchestrator.kt", // Reseller Withdraw, one-shot
        )
        for (fileName in oneShotOrchestrators) {
            val source = readSource(fileName)
            assertTrue(
                "$fileName never draws a visible dialog and must never call acquireSession()/InteractiveUssdScreenLock",
                !source.contains("acquireSession()") && !source.contains("InteractiveUssdScreenLock"),
            )
        }
    }

    @Test
    fun `both bridges delegate their session lock to the same shared InteractiveUssdScreenLock object`() {
        val bridgeFiles = listOf("ExchangeUssdBridge.kt", "ResellerWithdrawalInteractiveUssdBridge.kt")
        for (fileName in bridgeFiles) {
            val source = readSource(fileName)
            assertTrue(
                "$fileName's acquireSession/releaseSession must delegate to the single shared InteractiveUssdScreenLock, " +
                    "not hold a lock of its own -- two separate locks would defeat the whole point",
                source.contains("InteractiveUssdScreenLock.acquire()") && source.contains("InteractiveUssdScreenLock.release()"),
            )
        }
    }
}
