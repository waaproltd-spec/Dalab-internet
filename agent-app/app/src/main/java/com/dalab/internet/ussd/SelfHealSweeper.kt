package com.dalab.internet.ussd

import android.content.Context
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.data.Order
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.queue.RetryClassifier
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Closes the last gap in the automatic pipeline: an order that reached
 * in_progress with a generated USSD string but was never actually dialed --
 * either because generation failed at verify-payment time and was fixed
 * afterward by a Super Admin (the backend's selfHealStuckOrders broadcasts
 * order.updated once it re-succeeds), or because the app died between
 * verify-payment succeeding and the dial ever starting. Triggered both on
 * every SSE order-updated event (near-immediate) and a periodic sweep
 * (backstop for a missed event) -- same one-two pattern QueueDrainer already
 * uses for connectivity-restored vs. its own polling loop.
 */
object SelfHealSweeper {
    // Same-device de-dupe only: the SSE-triggered sweep and the periodic
    // sweep can overlap, so without this both could read one candidate
    // before either starts dialing and call executeManually twice for the
    // same order from THIS device. The actual "never complete an order
    // twice" guarantee is unchanged and still server-side
    // (payment_transactions' markPaymentProcessing/markPaymentFinal guard).
    private val mutex = Mutex()
    private val inFlight = mutableSetOf<String>()

    // A stuck order with genuinely no SIM routing configured re-appears in
    // every sweep (this runs every ~60s) until an admin fixes it — logging
    // the identical "not configured"/"cache failed to load" line every
    // single pass floods Diagnostics (and the batch this uploads to the
    // backend's heartbeat, capped at 50 entries) with thousands of
    // duplicate rows for one real problem, burying anything else. Logged
    // once per (order, reason) until either the reason changes or the order
    // drops out of the candidate list (fixed, or otherwise resolved) --
    // never suppressed forever, just not repeated every tick for no reason.
    private val lastSkipReasonLogged = mutableMapOf<String, String>()

    suspend fun sweep(context: Context) {
        val candidates = try {
            RetryClassifier.requireSuccessful(ApiClient.service.getSelfHealCandidates()).body().orEmpty()
        } catch (e: Exception) {
            // A non-2xx response now throws here instead of silently
            // resolving to an empty list — this sweep is one of two
            // independent recovery paths for a stuck order, so a transient
            // failure needs to be visible (it'll simply be retried on the
            // next sweep) rather than indistinguishable from "nothing to do."
            DiagnosticsLog.record("self_heal_sweep", "Could not fetch candidates: ${e.message}", isError = false)
            return
        }
        // Mark-and-sweep: forget any order no longer stuck, so if it gets
        // routed, fails for a NEW reason later, or reappears after being
        // fixed, that's logged fresh rather than staying silenced forever.
        // Guarded by the same mutex as inFlight below -- the SSE-triggered
        // and periodic sweeps can run this concurrently on different
        // threads, and a plain HashMap isn't safe under that.
        mutex.withLock { lastSkipReasonLogged.keys.retainAll(candidates.map { it.id }.toSet()) }
        if (candidates.isEmpty()) return

        val orchestrator = UssdOrchestrator(context)
        for (order in candidates) {
            val claimed = mutex.withLock {
                if (order.id in inFlight) false else { inFlight.add(order.id); true }
            }
            if (!claimed) continue
            try {
                // NotConfigured and LoadFailed both still result in "skip this
                // pass, try again next sweep" — a later sweep (periodic or the
                // next SSE event) can retry either without needing to act on
                // them differently the way the live-SMS dial path does — but
                // they're now logged distinctly so a technician reading
                // Diagnostics isn't misled between "go configure SIM routing"
                // and "transient network blip, will retry automatically."
                val slot = when (val result = resolveSlot(order)) {
                    is SimSlotResult.Slot -> result.slot
                    SimSlotResult.NotConfigured -> {
                        // Names the company (and its id) directly in the
                        // message — the whole point is that whoever reads
                        // this shouldn't need to separately look up which
                        // provider order.id belongs to before they know what
                        // to configure in Admin > Device & USSD > SIM Routing.
                        logSkipOnce(
                            order.id,
                            "not_configured",
                            "No SIM routing configured for ${order.companyName} (${order.companyId}) — order ${order.id} — skipping. " +
                                "Add a SIM Routing entry for this company/device in Admin; this order retries automatically once one exists.",
                        )
                        continue
                    }
                    SimSlotResult.LoadFailed -> {
                        logSkipOnce(order.id, "load_failed", "SIM routing cache failed to load for order ${order.id} — will retry next sweep.")
                        continue
                    }
                }
                mutex.withLock { lastSkipReasonLogged.remove(order.id) }
                DiagnosticsLog.record("self_heal_sweep", "Auto-dialing order ${order.id} (SIM $slot) after a config fix.", isError = false)
                val result = orchestrator.executeManually(order.id, slot)
                DiagnosticsLog.record(
                    "self_heal_sweep",
                    "Order ${order.id} self-heal dial result: ${result.outcome}${result.responseMessage?.let { " — $it" } ?: ""}",
                    isError = result.outcome != DialOutcome.SUCCESS && result.outcome != DialOutcome.DUPLICATE_SKIPPED,
                )
            } finally {
                mutex.withLock { inFlight.remove(order.id) }
            }
        }
    }

    private suspend fun logSkipOnce(orderId: String, reasonKey: String, message: String) {
        val alreadyLogged = mutex.withLock {
            val unchanged = lastSkipReasonLogged[orderId] == reasonKey
            lastSkipReasonLogged[orderId] = reasonKey
            unchanged
        }
        if (!alreadyLogged) DiagnosticsLog.record("self_heal_sweep", message, isError = false)
    }

    private suspend fun resolveSlot(order: Order): SimSlotResult {
        if (order.ussdDeviceId != null && order.ussdDeviceId == DeviceIdentity.deviceId() && order.ussdSimSlot != null) {
            return SimSlotResult.Slot(order.ussdSimSlot)
        }
        return SimRoutingRepository.simSlotFor(order.companyId)
    }
}
