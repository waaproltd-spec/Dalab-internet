package com.dalab.internet.ussd

import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Caches GET /agent/sim-routing in memory so the orchestrator doesn't hit the
 * network on every single incoming SMS. Call refresh() on app start and
 * periodically (e.g. alongside the existing RealtimeClient reconnect logic)
 * so a routing change the Super Admin makes takes effect without requiring
 * an app restart.
 *
 * Scoped to this physical device's [DeviceIdentity] — routing is now a
 * ranked list per company (a company can have a primary + backup device),
 * so fetching unscoped would pull in every company's routing including ones
 * configured for the OTHER device, and this device would wrongly attempt to
 * dial them on its own local SIM slot numbering.
 */
object SimRoutingRepository {
    @Volatile private var cache: Map<String, Int> = emptyMap() // companyId -> simSlot (1 or 2)
    @Volatile private var hasLoadedOnce = false
    private val refreshMutex = Mutex()

    suspend fun refresh(): Result<Unit> {
        return try {
            val response = ApiClient.service.getSimRouting(deviceId = DeviceIdentity.deviceId())
            if (response.isSuccessful) {
                cache = response.body()?.associate { it.companyId to it.simSlot } ?: emptyMap()
                hasLoadedOnce = true
                Result.success(Unit)
            } else {
                val error = IllegalStateException("Failed to load SIM routing: HTTP ${response.code()}")
                DiagnosticsLog.record("sim_routing_refresh", error.message ?: "unknown error")
                Result.failure(error)
            }
        } catch (e: Exception) {
            DiagnosticsLog.record("sim_routing_refresh", e.message ?: "unknown error")
            Result.failure(e)
        }
    }

    /**
     * Null means "the Super Admin hasn't configured routing for this
     * provider" — a genuine no-config case. But AgentBackgroundService's
     * periodic refresh() is fire-and-forget with nothing gating incoming SMS
     * processing on the FIRST one landing, so a payment SMS arriving in the
     * narrow window right after an app/device restart could hit an empty
     * cache and be treated as "no config" when really it's just "not loaded
     * yet." Blocking once on a live refresh here (mutex-guarded so several
     * SMS arriving in that same window don't each trigger their own refresh)
     * closes that race instead of failing fast.
     */
    suspend fun simSlotFor(companyId: String): SimSlotResult {
        if (!hasLoadedOnce) {
            refreshMutex.withLock {
                if (!hasLoadedOnce) {
                    val result = refresh()
                    if (result.isFailure) return SimSlotResult.LoadFailed
                }
            }
        }
        return cache[companyId]?.let { SimSlotResult.Slot(it) } ?: SimSlotResult.NotConfigured
    }

    /** Non-suspend, no self-heal — for UI-only "recommended SIM" hints
     * (a starred suggestion next to the real Execute/Dial buttons) where
     * blocking Compose's `remember {}` on a network call would be wrong.
     * The actual dial path always goes through [simSlotFor] instead. */
    fun cachedSlotFor(companyId: String): Int? = cache[companyId]
}
