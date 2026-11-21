package com.dalab.internet.sms

import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient

/** Mirrors GET /agent/sms-sender-ids. */
data class SmsSenderIdEntry(
    val providerKey: String,
    val sender: String,
)

/**
 * Caches GET /agent/sms-sender-ids in memory, the same way
 * [com.dalab.internet.ussd.SimRoutingRepository] caches SIM routing --
 * replaces what used to be hardcoded sender lists in each
 * PaymentSmsParser/ExchangePayoutSentParser (see PaymentSmsParsers.kt) with
 * a Super-Admin-configurable registry, so a provider's real SMS sender
 * ID(s) can be corrected from the dashboard without an app update.
 *
 * [sendersFor] is the only accessor parsers may call: PaymentSmsParsers.parse()
 * and ExchangePayoutSentParsers.parse() run synchronously on SmsReceiver's
 * main thread, before goAsync() is called, so a blocking/suspend network
 * call at that point would violate the BroadcastReceiver contract. It must
 * read whatever [refresh] has already populated -- never fetch live.
 */
object SmsSenderIdRepository {
    @Volatile private var cache: Map<String, List<String>> = emptyMap() // providerKey -> senders

    /** The last failure message actually logged to Diagnostics -- caps
     * logging to once per distinct error instead of once per ~60s refresh
     * loop tick for as long as the backend keeps returning the same failure
     * (e.g. the route not deployed yet). Cleared on a successful refresh so
     * a later, different (or recovered-then-repeated) failure still logs.
     * Same dedup shape as ExchangeUssdBridge.shouldLogWindowMismatch
     * elsewhere in this codebase. */
    @Volatile private var lastLoggedFailure: String? = null

    suspend fun refresh(): Result<Unit> {
        return try {
            val response = ApiClient.service.getSmsSenderIds()
            if (response.isSuccessful) {
                cache = response.body()
                    ?.groupBy({ it.providerKey }, { it.sender })
                    ?: emptyMap()
                lastLoggedFailure = null
                Result.success(Unit)
            } else {
                val error = IllegalStateException("Failed to load SMS sender IDs: HTTP ${response.code()}")
                logFailureIfNew(error.message ?: "unknown error")
                Result.failure(error)
            }
        } catch (e: Exception) {
            logFailureIfNew(e.message ?: "unknown error")
            Result.failure(e)
        }
    }

    private fun logFailureIfNew(message: String) {
        if (message == lastLoggedFailure) return
        lastLoggedFailure = message
        DiagnosticsLog.record("sms_sender_ids_refresh", message)
    }

    /**
     * Non-suspend, non-blocking read of whatever the last successful
     * [refresh] loaded for [providerKey]. Falls back to [defaults] -- each
     * parser's own current hardcoded list -- whenever the registry hasn't
     * loaded this provider key yet (fresh install, offline device, or the
     * Super Admin simply hasn't added rows for it), so behavior never
     * regresses to "accept any sender" or "accept nothing."
     */
    fun sendersFor(providerKey: String, defaults: List<String>): List<String> =
        cache[providerKey]?.takeIf { it.isNotEmpty() } ?: defaults
}
