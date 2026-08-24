package com.dalab.internet.ussd

import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Reseller Withdraw's OWN SIM routing cache — exact structural mirror of
 * [SimRoutingRepository], just against GET /agent/reseller-withdrawal-sim-routing
 * (reseller_withdrawal_sim_routing, migration 058) instead of the Internet
 * Store/eBadal recharge routing table. Kept as a genuinely separate cache,
 * not a shared one, per product decision: a company's withdrawal payout SIM
 * can be pointed at a different device than that same company's recharge
 * SIM, so the two must never be conflated client-side either.
 */
object ResellerWithdrawalSimRoutingRepository {
    @Volatile private var cache: Map<String, ResellerWithdrawalSimRoute> = emptyMap() // companyId -> route
    @Volatile private var hasLoadedOnce = false
    private val refreshMutex = Mutex()

    suspend fun refresh(): Result<Unit> {
        return try {
            val response = ApiClient.service.getResellerWithdrawalSimRouting(deviceId = DeviceIdentity.deviceId())
            if (response.isSuccessful) {
                cache = response.body()?.associate { it.companyId to ResellerWithdrawalSimRoute(it.simSlot, it.mobileNumber) } ?: emptyMap()
                hasLoadedOnce = true
                Result.success(Unit)
            } else {
                val error = IllegalStateException("Failed to load Reseller Withdraw SIM routing: HTTP ${response.code()}")
                DiagnosticsLog.record("reseller_withdrawal_sim_routing_refresh", error.message ?: "unknown error")
                Result.failure(error)
            }
        } catch (e: Exception) {
            DiagnosticsLog.record("reseller_withdrawal_sim_routing_refresh", e.message ?: "unknown error")
            Result.failure(e)
        }
    }

    /** Same cold-start race guard as SimRoutingRepository.simSlotFor — see
     * its doc comment for why a blocking one-shot refresh is needed here
     * instead of just trusting hasLoadedOnce's false branch as "no config". */
    suspend fun routeFor(companyId: String): ResellerWithdrawalSimRouteResult {
        if (!hasLoadedOnce) {
            refreshMutex.withLock {
                if (!hasLoadedOnce) {
                    val result = refresh()
                    if (result.isFailure) return ResellerWithdrawalSimRouteResult.LoadFailed
                }
            }
        }
        return cache[companyId]?.let { ResellerWithdrawalSimRouteResult.Route(it) } ?: ResellerWithdrawalSimRouteResult.NotConfigured
    }
}

data class ResellerWithdrawalSimRoute(val simSlot: Int, val mobileNumber: String?)

sealed class ResellerWithdrawalSimRouteResult {
    data class Route(val route: ResellerWithdrawalSimRoute) : ResellerWithdrawalSimRouteResult()
    object NotConfigured : ResellerWithdrawalSimRouteResult()
    object LoadFailed : ResellerWithdrawalSimRouteResult()
}
