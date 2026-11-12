package com.dalab.internet.auth

import android.content.Context
import android.content.SharedPreferences
import com.dalab.internet.data.AgentProfile
import com.dalab.internet.util.SecurePrefs

/**
 * Stores the agent's JWT access/refresh tokens and profile in
 * EncryptedSharedPreferences (androidx.security.crypto) — the tokens are
 * encrypted at rest with a key held in the Android Keystore, not
 * recoverable by just pulling the app's shared_prefs XML off a rooted/
 * backed-up device the way plain SharedPreferences would be. See
 * [SecurePrefs] for what happens if the Keystore-backed store itself can't
 * be created on this device (self-heals to plain storage rather than
 * leaving `prefs` permanently uninitialized).
 */
object SessionManager {
    private const val PREFS = "dalab_agent_session"
    private const val KEY_ACCESS = "access_token"
    private const val KEY_REFRESH = "refresh_token"
    private const val KEY_AGENT_ID = "agent_id"
    private const val KEY_AGENT_NAME = "agent_name"
    private const val KEY_AGENT_PHONE = "agent_phone"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = SecurePrefs.createOrFallback(context, PREFS, "session_init")
    }

    fun saveSession(accessToken: String, refreshToken: String, profile: AgentProfile) {
        prefs.edit()
            .putString(KEY_ACCESS, accessToken)
            .putString(KEY_REFRESH, refreshToken)
            .putString(KEY_AGENT_ID, profile.id)
            .putString(KEY_AGENT_NAME, profile.name)
            .putString(KEY_AGENT_PHONE, profile.phone)
            .apply()
    }

    /** Used by the refresh flow, which rotates both tokens but doesn't touch the profile. */
    fun updateTokens(accessToken: String, refreshToken: String) {
        prefs.edit()
            .putString(KEY_ACCESS, accessToken)
            .putString(KEY_REFRESH, refreshToken)
            .apply()
    }

    fun accessToken(): String? = prefs.getString(KEY_ACCESS, null)
    fun refreshToken(): String? = prefs.getString(KEY_REFRESH, null)
    fun isLoggedIn(): Boolean = accessToken() != null

    fun currentAgent(): AgentProfile? {
        val id = prefs.getString(KEY_AGENT_ID, null) ?: return null
        return AgentProfile(
            id = id,
            name = prefs.getString(KEY_AGENT_NAME, "") ?: "",
            phone = prefs.getString(KEY_AGENT_PHONE, "") ?: "",
        )
    }

    fun clear() {
        prefs.edit().clear().apply()
    }
}
