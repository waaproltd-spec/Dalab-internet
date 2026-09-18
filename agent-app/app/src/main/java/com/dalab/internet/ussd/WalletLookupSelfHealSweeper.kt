package com.dalab.internet.ussd

import android.content.Context
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.queue.RetryClassifier
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The automatic trigger for Wallet Name Lookups (the customer app's
 * "Complete Account" flow): the moment a customer submits a wallet number,
 * this device (and every other agent device running the sweep) sees it via
 * GET /agent/wallet-lookups and races to claim it — same shared-queue,
 * backend-enforced-idempotency shape as [ExchangeSelfHealSweeper], not a
 * push to one specific device. Only one device actually wins a given
 * lookup (the claim endpoint's atomic UPDATE — see
 * exchange.routes.ts — ensures that), so dialing it here is always safe
 * even though every device polls the same list.
 */
object WalletLookupSelfHealSweeper {
    private val mutex = Mutex()
    private val inFlight = mutableSetOf<String>()

    suspend fun sweep(context: Context) {
        val candidates = try {
            RetryClassifier.requireSuccessful(ApiClient.service.getWalletLookups()).body().orEmpty()
        } catch (e: Exception) {
            DiagnosticsLog.record("wallet_lookup_self_heal_sweep", "Could not fetch wallet lookups: ${e.message}", isError = false)
            return
        }
        if (candidates.isEmpty()) return

        val orchestrator = WalletLookupUssdOrchestrator(context)
        // Sequential, not parallel — same reasoning as
        // ExchangeSelfHealSweeper: one foreground USSD dialog, one SIM
        // config, at a time.
        for (pending in candidates) {
            val claimed = mutex.withLock {
                if (pending.id in inFlight) false else { inFlight.add(pending.id); true }
            }
            if (!claimed) continue
            try {
                DiagnosticsLog.record("wallet_lookup_self_heal_sweep", "Auto-dialing wallet lookup ${pending.id} (${pending.walletId}).", isError = false)
                val result = orchestrator.executeLookup(pending)
                DiagnosticsLog.record(
                    "wallet_lookup_self_heal_sweep",
                    "Wallet lookup ${pending.id} (${pending.walletId}) result: ${result.outcome}${result.message?.let { " — $it" } ?: ""}",
                    isError = result.outcome != WalletLookupOutcome.SUCCESS && result.outcome != WalletLookupOutcome.ALREADY_CLAIMED,
                )
            } catch (e: Exception) {
                DiagnosticsLog.record("wallet_lookup_self_heal_sweep", "Lookup ${pending.id} threw: ${e.stackTraceToString().take(2000)}")
            } finally {
                mutex.withLock { inFlight.remove(pending.id) }
            }
        }
    }
}
