package com.dalab.internet.auth

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.dalab.internet.network.ApiClient

data class MyServicesResponse(val services: List<String>? = null, val all: List<String>? = null)

/**
 * The services the Owner allowed this agent (GET /agent/me/services). The
 * app shows only those; the server refuses the rest anyway, at once. Until
 * the first answer -- or on a system that doesn't have per-agent services
 * yet (404) -- nothing is hidden, exactly as before.
 */
object AgentServices {
    /** null = not known / not used by this system: everything shown. */
    var granted by mutableStateOf<Set<String>?>(null)
        private set

    fun allowed(vararg keys: String): Boolean {
        val g = granted ?: return true
        return keys.any { it in g }
    }

    suspend fun refresh() {
        try {
            val r = ApiClient.service.getMyServices()
            when {
                r.isSuccessful -> granted = r.body()?.services.orEmpty().toSet()
                r.code() == 404 -> granted = null
                // Any other answer (offline, server error): keep what we knew.
            }
        } catch (_: Exception) {
        }
    }

    fun clear() {
        granted = null
    }
}
