package com.dalab.internet.customer.auth

import android.content.Context
import android.content.SharedPreferences
import com.dalab.internet.customer.data.CustomerProfile

/**
 * Stores the customer's JWT access/refresh tokens and profile. In production,
 * prefer EncryptedSharedPreferences (androidx.security.crypto) over plain
 * SharedPreferences for anything holding tokens — plain prefs are shown here
 * for clarity/brevity, matching the same trade-off the Agent App makes.
 */
object SessionManager {
    private const val PREFS = "dalab_customer_session"
    private const val KEY_ACCESS = "access_token"
    private const val KEY_REFRESH = "refresh_token"
    private const val KEY_CUSTOMER_ID = "customer_id"
    private const val KEY_CUSTOMER_NAME = "customer_name"
    private const val KEY_CUSTOMER_PHONE = "customer_phone"
    private const val KEY_PIN_SET = "customer_pin_set"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    fun saveSession(accessToken: String, refreshToken: String, profile: CustomerProfile, pinSet: Boolean = false) {
        prefs.edit()
            .putString(KEY_ACCESS, accessToken)
            .putString(KEY_REFRESH, refreshToken)
            .putString(KEY_CUSTOMER_ID, profile.id)
            .putString(KEY_CUSTOMER_NAME, profile.name)
            .putString(KEY_CUSTOMER_PHONE, profile.phone)
            .putBoolean(KEY_PIN_SET, pinSet)
            .apply()
    }

    /** Kept in sync whenever the customer creates/changes/removes their optional PIN from Profile. */
    fun updatePinSet(pinSet: Boolean) {
        prefs.edit().putBoolean(KEY_PIN_SET, pinSet).apply()
    }

    fun isPinSet(): Boolean = prefs.getBoolean(KEY_PIN_SET, false)

    fun updateProfile(profile: CustomerProfile) {
        prefs.edit()
            .putString(KEY_CUSTOMER_NAME, profile.name)
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

    fun currentCustomer(): CustomerProfile? {
        val id = prefs.getString(KEY_CUSTOMER_ID, null) ?: return null
        return CustomerProfile(
            id = id,
            phone = prefs.getString(KEY_CUSTOMER_PHONE, "") ?: "",
            name = prefs.getString(KEY_CUSTOMER_NAME, null),
        )
    }

    fun clear() {
        prefs.edit().clear().apply()
    }
}
