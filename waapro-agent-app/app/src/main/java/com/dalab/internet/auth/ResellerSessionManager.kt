package com.dalab.internet.auth

import android.content.Context
import android.content.SharedPreferences
import com.dalab.internet.data.ResellerProfile
import com.dalab.internet.util.SecurePrefs

/**
 * Stores the logged-in reseller's JWT access/refresh tokens and identity,
 * completely separate from [SessionManager] (the Agent App's own
 * agent-device session). An agent using this app can be logged in as an
 * agent (role "agent", used everywhere else in the app -- USSD dialing,
 * orders, etc.) AND, independently, logged in as a reseller (role
 * "reseller", used only by the Reseller screens under More -> Reseller) at
 * the same time; logging out of one must never touch the other. See
 * network/ResellerApiClient.kt for the separate Retrofit client that reads
 * tokens from here instead of from [SessionManager].
 */
object ResellerSessionManager {
    private const val PREFS = "dalab_reseller_session"
    private const val KEY_ACCESS = "access_token"
    private const val KEY_REFRESH = "refresh_token"
    private const val KEY_RESELLER_ID = "reseller_id"
    private const val KEY_RESELLER_LOGIN_ID = "reseller_login_id"
    private const val KEY_RESELLER_NAME = "reseller_name"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = SecurePrefs.createOrFallback(context, PREFS, "reseller_session_init")
    }

    fun saveSession(accessToken: String, refreshToken: String, reseller: ResellerProfile) {
        prefs.edit()
            .putString(KEY_ACCESS, accessToken)
            .putString(KEY_REFRESH, refreshToken)
            .putString(KEY_RESELLER_ID, reseller.id)
            .putString(KEY_RESELLER_LOGIN_ID, reseller.resellerLoginId)
            .putString(KEY_RESELLER_NAME, reseller.name)
            .apply()
    }

    /** Used by the refresh flow, which rotates both tokens but doesn't touch the identity. */
    fun updateTokens(accessToken: String, refreshToken: String) {
        prefs.edit()
            .putString(KEY_ACCESS, accessToken)
            .putString(KEY_REFRESH, refreshToken)
            .apply()
    }

    fun accessToken(): String? = prefs.getString(KEY_ACCESS, null)
    fun refreshToken(): String? = prefs.getString(KEY_REFRESH, null)
    fun isLoggedIn(): Boolean = accessToken() != null

    /** Identity only (login id/name) for display before the dashboard's own
     * GET /reseller/me finishes -- never the wallet balance, which goes
     * stale the moment it changes; screens always show the freshly-fetched
     * value instead of trusting anything cached here. */
    fun currentReseller(): ResellerProfile? {
        val id = prefs.getString(KEY_RESELLER_ID, null) ?: return null
        return ResellerProfile(
            id = id,
            resellerLoginId = prefs.getString(KEY_RESELLER_LOGIN_ID, "") ?: "",
            name = prefs.getString(KEY_RESELLER_NAME, "") ?: "",
            walletBalance = 0.0,
        )
    }

    fun clear() {
        prefs.edit().clear().apply()
    }
}
