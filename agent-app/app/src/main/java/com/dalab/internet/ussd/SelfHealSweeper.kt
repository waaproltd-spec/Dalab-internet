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
        if (candidates.isEmpty()) return

        val orchestrator = UssdOrchestrator(context)
        for (order in candidates) {
            val claimed = mutex.withLock {
                if (order.id in inFlight) false else { inFlight.add(order.id); true }
            }
            if (!claimed) continue
            try {
                val slot = resolveSlot(order)
                if (slot == null) {
                    DiagnosticsLog.record("self_heal_sweep", "No SIM routing for order ${order.id} on this device — skipping.", isError = false)
                    continue
                }
                DiagnosticsLog.record("self_heal_sweep", "Auto-dialing order ${order.id} (SIM $slot) after a config fix.", isError = false)
                orchestrator.executeManually(order.id, slot)
            } finally {
                mutex.withLock { inFlight.remove(order.id) }
            }
        }
    }

    // NotConfigured and LoadFailed are both "skip this pass, try again next
    // sweep" here — a LoadFailed's underlying network blip and a genuinely
    // unconfigured route are both things a later sweep (periodic or the next
    // SSE event) can retry without needing to distinguish them the way the
    // live-SMS dial path does.
    private suspend fun resolveSlot(order: Order): Int? {
        if (order.ussdDeviceId != null && order.ussdDeviceId == DeviceIdentity.deviceId() && order.ussdSimSlot != null) {
            return order.ussdSimSlot
        }
        return (SimRoutingRepository.simSlotFor(order.companyId) as? SimSlotResult.Slot)?.slot
    }
}
