package com.dalab.internet.ussd

import android.content.Context
import android.os.PowerManager
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.WalletLookupPending
import com.dalab.internet.network.WalletLookupReportRequest
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Wallet Name Lookup (the customer app's "Complete Account" flow) — dials
 * the same $1 EVC Plus/eDahab Dial-to-Pay prompt a real Money Exchange
 * payout's Step 1 does (see ExchangeUssdOrchestrator), reads the carrier's
 * own registered-name response, and — critically — goes NO FURTHER: no PIN
 * is ever armed, no money ever moves, and the dialog is actively cancelled
 * the moment the name has been read. This is a read-only identity check,
 * never a transfer, which is why it has its own orchestrator rather than a
 * flag on ExchangeUssdOrchestrator — keeping "this path can never inject a
 * PIN" true by construction (the PIN-arming call simply does not exist
 * anywhere in this file) rather than by a runtime condition that could be
 * gotten wrong.
 *
 * Safety rule (explicit product requirement): if the registered name can't
 * be confidently read, this reports 'failed' and stops — never guesses,
 * never retries automatically, never lets a customer save an unverified
 * name. See WalletNameLookupParser's own fail-safe contract.
 */
class WalletLookupUssdOrchestrator(private val context: Context) {
    private val dialer = ExchangeUssdDialer(context)

    suspend fun executeLookup(pending: WalletLookupPending): WalletLookupResult {
        if (!claim(pending.id)) {
            return WalletLookupResult(WalletLookupOutcome.ALREADY_CLAIMED, message = "Already being processed on this device — skipped to avoid a duplicate dial.")
        }
        try {
            val result = executeLocked(pending)
            DiagnosticsLog.record(
                "wallet_lookup_final_action",
                "[lookup=${pending.id} wallet=${pending.walletId}] Final action: ${result.outcome}${result.message?.let { " -- $it" } ?: ""}",
                isError = result.outcome != WalletLookupOutcome.SUCCESS && result.outcome != WalletLookupOutcome.ALREADY_CLAIMED,
            )
            return result
        } finally {
            release(pending.id)
        }
    }

    private suspend fun executeLocked(pending: WalletLookupPending): WalletLookupResult {
        // Checked BEFORE claiming (unlike a real payout, which claims first)
        // deliberately: claiming consumes this lookup from the shared queue
        // for good (see PUT /agent/wallet-lookups/:id's fail-safe, terminal
        // 'failed' status — there is no automatic re-queue). A device that
        // can't even attempt the dial should never take that slot away from
        // one that can.
        if (!ExchangeUssdBridge.isAccessibilityServiceEnabled(context)) {
            return WalletLookupResult(WalletLookupOutcome.ACCESSIBILITY_NOT_ENABLED, message = "Automated lookup isn't enabled on this device.")
        }
        if (!dialer.hasRequiredPermissions()) {
            return WalletLookupResult(WalletLookupOutcome.PERMISSION_DENIED, message = "Phone permissions aren't granted on this device.")
        }

        val claimResponse = try {
            ApiClient.service.claimWalletLookup(pending.id)
        } catch (e: Exception) {
            DiagnosticsLog.record("wallet_lookup_claim", "Could not reach server (lookup ${pending.id}): ${e.message}")
            return WalletLookupResult(WalletLookupOutcome.NETWORK_UNAVAILABLE, message = "Could not reach server: ${e.message}")
        }
        if (claimResponse.code() == 409) {
            return WalletLookupResult(WalletLookupOutcome.ALREADY_CLAIMED, message = "Another device already claimed this lookup.")
        }
        val body = claimResponse.body()
        if (!claimResponse.isSuccessful || body == null) {
            return WalletLookupResult(WalletLookupOutcome.NETWORK_UNAVAILABLE, message = "Could not start the lookup — check the dashboard.")
        }

        val subscriptionLookup = dialer.subscriptionIdForSlot(body.simSlot)
        val subscriptionId = when (subscriptionLookup) {
            SubscriptionLookupResult.PermissionMissing -> {
                reportFailed(pending.id, "Required phone permissions aren't granted on this device.")
                return WalletLookupResult(WalletLookupOutcome.PERMISSION_DENIED, message = "Required phone permissions aren't granted on this device.")
            }
            SubscriptionLookupResult.NotPresent -> {
                reportFailed(pending.id, "SIM ${body.simSlot} isn't physically inserted on this device.")
                return WalletLookupResult(WalletLookupOutcome.NO_SIM_PRESENT, message = "SIM ${body.simSlot} isn't physically inserted on this device.")
            }
            is SubscriptionLookupResult.Found -> subscriptionLookup.subscriptionId
        }

        // Same screen-on wake lock rationale as ExchangeUssdOrchestrator —
        // the accessibility service needs the carrier's reply dialog to
        // actually be drawn, not just dialed with the screen off. A shorter
        // hold than the real 2-step payout's since this is a single read
        // step, not a whole PIN flow.
        @Suppress("DEPRECATION")
        val wakeLock = (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)
            ?.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                "DalabAgent:WalletLookupUssdDial",
            )
        // Waits its turn for this lookup's own SIM slot -- every other flow
        // that can dial that same slot (Internet Store recharge, a real
        // Money Exchange payout, Reseller Withdraw) goes through this same
        // lock; see UssdSimLock's doc comment. "Now" is used as the arrival
        // time (not a real creation timestamp) since a lookup has no
        // cross-flow-discovery-race to solve the way Exchange/Reseller do —
        // see UssdSimLock's own doc comment for that distinction.
        val sessionTicket = UssdSimLock.acquire(
            simSlot = body.simSlot,
            requestId = "wallet-lookup:${pending.id}",
            arrivalTimeMs = System.currentTimeMillis(),
        )

        wakeLock?.acquire(45_000)
        ExchangeUssdBridge.activeWakeLock = wakeLock
        // Second, separate lock beyond the per-slot UssdSimLock above --
        // this lookup and a concurrent real Money Exchange payout on a
        // DIFFERENT SIM slot both drive THIS SAME shared bridge/
        // accessibility service (WalletLookupUssdOrchestrator reuses
        // ExchangeUssdBridge rather than duplicating its dialog-detection
        // heuristics); see ExchangeUssdBridge's own doc comment for the live
        // incident this closes. Always acquired after UssdSimLock, never
        // before, so the two locks can't deadlock against each other.
        ExchangeUssdBridge.acquireSession()
        ExchangeUssdBridge.arm(orderId = pending.id, attemptId = body.id)
        try {
            // See ExchangeUssdOrchestrator's identical comment: this
            // synchronous startActivity(ACTION_CALL) dial can throw
            // (revoked CALL_PHONE, no dialer Activity to launch on a
            // policy-restricted device) with nothing else around it to
            // catch it, which previously crashed the coroutine before
            // reportFailed below ever ran, leaving this lookup permanently
            // unresolved server-side.
            try {
                dialer.dial(subscriptionId, body.lookupUssdString)
            } catch (e: Exception) {
                DiagnosticsLog.record("wallet_lookup_dial", "Dial threw (lookup ${pending.id}): ${e.message}", isError = true)
                reportFailed(pending.id, null)
                return WalletLookupResult(WalletLookupOutcome.TIMEOUT, message = "Could not start the dial: ${e.message}")
            }

            val firstEvent = ExchangeUssdBridge.awaitNextEvent(30_000)
            if (firstEvent !is UssdDialogEvent.DialogSeen) {
                reportFailed(pending.id, null)
                return WalletLookupResult(WalletLookupOutcome.TIMEOUT, message = "No response from the carrier within 30s.")
            }

            val registeredName = WalletNameLookupParser.parseRegisteredName(firstEvent.text, body.phoneNumber)

            // Read-only, always: whether or not a name was parsed, the very
            // next thing this does is back out of the dialog — never wait
            // for or arm a PIN, regardless of outcome.
            ExchangeUssdBridge.armDialogCancellation()
            // Short wait purely so the Cancel tap has a moment to land
            // before this function releases the wake lock/disarms — its
            // own success or failure never changes what's reported below
            // (see armDialogCancellation's own doc comment: a lookup that
            // can't be actively cancelled is not itself unsafe, since no
            // PIN was ever typed into the dialog either way).
            ExchangeUssdBridge.awaitNextEvent(8_000)

            if (registeredName == null) {
                reportFailed(pending.id, firstEvent.text)
                return WalletLookupResult(WalletLookupOutcome.NOT_FOUND, message = "Could not read a registered name from the carrier's response.")
            }

            reportSuccess(pending.id, registeredName, firstEvent.text)
            return WalletLookupResult(WalletLookupOutcome.SUCCESS, registeredName = registeredName)
        } finally {
            ExchangeUssdBridge.disarm()
            ExchangeUssdBridge.releaseSession()
            if (wakeLock?.isHeld == true) wakeLock.release()
            ExchangeUssdBridge.activeWakeLock = null
            UssdSimLock.release(sessionTicket)
        }
    }

    private suspend fun reportSuccess(lookupId: String, registeredName: String, rawResponse: String) {
        try {
            ApiClient.service.reportWalletLookup(lookupId, WalletLookupReportRequest("success", registeredName, rawResponse))
        } catch (e: Exception) {
            DiagnosticsLog.record("wallet_lookup_report", "Failed to report success for lookup $lookupId: ${e.message}")
        }
    }

    // Fail-safe, matching the product's own explicit rule: every failure
    // path reports 'failed' rather than being silently dropped, so the
    // lookup never sits stranded at 'claimed' and the customer app's poll
    // sees a definite terminal answer instead of spinning forever. No
    // automatic retry from here — see this class's own doc comment.
    private suspend fun reportFailed(lookupId: String, rawResponse: String?) {
        try {
            ApiClient.service.reportWalletLookup(lookupId, WalletLookupReportRequest("failed", null, rawResponse))
        } catch (e: Exception) {
            DiagnosticsLog.record("wallet_lookup_report", "Failed to report failure for lookup $lookupId: ${e.message}")
        }
    }

    companion object {
        // Same same-device in-flight guard shape as ExchangeUssdOrchestrator.
        private val inFlightMutex = Mutex()
        private val inFlightIds = mutableSetOf<String>()

        private suspend fun claim(id: String): Boolean = inFlightMutex.withLock {
            if (id in inFlightIds) false else { inFlightIds.add(id); true }
        }

        private suspend fun release(id: String) {
            inFlightMutex.withLock { inFlightIds.remove(id) }
        }
    }
}
