package com.dalab.internet.ussd

import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.google.gson.JsonParser
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
            val response = ApiClient.service.getSimRoutingRaw(deviceId = DeviceIdentity.deviceId())
            if (!response.isSuccessful) {
                val error = IllegalStateException("Failed to load SIM routing: HTTP ${response.code()}")
                DiagnosticsLog.record("sim_routing_refresh", error.message ?: "unknown error")
                return Result.failure(error)
            }
            val rawBody = response.body()?.string()
            // Parsed manually (not via Retrofit's automatic
            // Response<List<SimRoutingEntry>> conversion, which this used to
            // use) because that conversion was throwing a bare
            // "ClassCastException: no message" in production on a device
            // that was otherwise online and reachable -- with the exception
            // surfacing deep inside Gson/Retrofit's own internals, there was
            // no way to see which row (or which field) actually caused it,
            // and a single bad row failed the ENTIRE refresh, silently
            // blocking automatic dialing for every company routed through
            // this device. Parsing element-by-element means one malformed
            // row is skipped and logged with its own raw JSON instead of
            // taking down every other (valid) row's routing with it.
            val elements = try {
                JsonParser.parseString(rawBody ?: "[]").asJsonArray
            } catch (e: Exception) {
                DiagnosticsLog.record(
                    "sim_routing_refresh",
                    "Response body isn't a JSON array (${e.javaClass.simpleName}: ${e.message ?: "no message"}). Raw body: ${(rawBody ?: "<empty>").take(1000)}",
                )
                return Result.failure(e)
            }
            val parsed = mutableMapOf<String, Int>()
            var skipped = 0
            for (element in elements) {
                try {
                    val obj = element.asJsonObject
                    val companyId = obj.get("companyId")?.asString
                        ?: throw IllegalStateException("missing companyId")
                    val simSlot = obj.get("simSlot")?.asInt
                        ?: throw IllegalStateException("missing/non-numeric simSlot")
                    parsed[companyId] = simSlot
                } catch (e: Exception) {
                    skipped++
                    DiagnosticsLog.record(
                        "sim_routing_refresh",
                        "Skipped one malformed sim-routing row (${e.javaClass.simpleName}: ${e.message ?: "no message"}). Raw row: $element",
                    )
                }
            }
            cache = parsed
            hasLoadedOnce = true
            // A per-row skip is already logged above with its own raw JSON --
            // this is still a genuine SUCCESS for every company whose row DID
            // parse (their cache entry is right there in `parsed`). Returning
            // failure here would make simSlotFor() treat one unrelated
            // company's bad row as LoadFailed for every OTHER company on this
            // device too, exactly undoing the point of parsing row-by-row.
            Result.success(Unit)
        } catch (e: Exception) {
            // Previously only e.message was recorded, which is null for a
            // real (if rare) class of exception -- a bare NullPointerException,
            // EOFException, or similar constructed with no message argument --
            // collapsing every such failure into the single unhelpful string
            // "unknown error" with no way to tell them apart or find the actual
            // failing line. This is exactly what happened in production:
            // repeated "unknown error" entries with the underlying cause never
            // recorded anywhere, on a device (network stack, auth, heartbeat)
            // that was otherwise online and reachable. The exception's own
            // class name plus a short stack trace is captured now instead, so
            // the next occurrence is actually diagnosable from Diagnostics
            // (More > Diagnostics) without needing a connected debugger.
            DiagnosticsLog.record(
                "sim_routing_refresh",
                "${e.javaClass.name}: ${e.message ?: "no message"}\n${e.stackTraceToString().take(1500)}",
            )
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
