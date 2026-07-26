package com.dalab.internet.ussd

import com.dalab.internet.network.ApiClient

/**
 * Caches GET /agent/sim-routing in memory so the orchestrator doesn't hit the
 * network on every single incoming SMS. Call refresh() on app start and
 * periodically (e.g. alongside the existing RealtimeClient reconnect logic)
 * so a routing change the Super Admin makes takes effect without requiring
 * an app restart.
 */
object SimRoutingRepository {
    @Volatile private var cache: Map<String, Int> = emptyMap() // companyId -> simSlot (1 or 2)

    suspend fun refresh(): Result<Unit> {
        return try {
            val response = ApiClient.service.getSimRouting()
            if (response.isSuccessful) {
                cache = response.body()?.associate { it.companyId to it.simSlot } ?: emptyMap()
                Result.success(Unit)
            } else {
                Result.failure(IllegalStateException("Failed to load SIM routing: HTTP ${response.code()}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /** Null if the Super Admin hasn't configured routing for this provider yet. */
    fun simSlotFor(companyId: String): Int? = cache[companyId]
}
