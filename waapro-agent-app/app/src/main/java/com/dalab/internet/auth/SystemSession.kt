package com.dalab.internet.auth

import android.content.Context
import android.content.SharedPreferences
import com.dalab.internet.util.SecurePrefs

/**
 * Which system (DALAB, Danwadaag, ...) this phone is signed in to. One app
 * serves every system: the agent never picks one. The Admin Hub finds it
 * from phone number + PIN at sign-in (see [HubLogin]) and hands back that
 * system's API address, which every API call then uses (ApiClient.BASE_URL).
 *
 * Kept apart from [SessionManager] so signing out (tokens gone) still
 * remembers the system: signing back in to the SAME system keeps this
 * phone's device setup, while a DIFFERENT system starts clean
 * ([SystemSwitch]).
 */
object SystemSession {
    private const val PREFS = "waapro_agent_system"
    private const val KEY_SYSTEM_KEY = "system_key"
    private const val KEY_SYSTEM_NAME = "system_name"
    private const val KEY_API_URL = "api_url"

    /** Used before any system is known; nothing is ever sent here on purpose. */
    const val NO_SYSTEM_URL = "https://admin.waaproltd.com/__no_system__/"

    private lateinit var prefs: SharedPreferences

    // In-memory copy: these are read on every API call (ApiClient.BASE_URL)
    // and every time a screen draws the system's logo or name, often on the
    // main thread. Decrypting EncryptedSharedPreferences each time made the
    // app stop responding, so the encrypted store is read once and then only
    // written.
    private class Snapshot(val key: String?, val name: String?, val apiUrl: String?)
    @Volatile private var snapshot: Snapshot? = null

    private fun current(): Snapshot {
        snapshot?.let { return it }
        synchronized(this) {
            snapshot?.let { return it }
            if (!::prefs.isInitialized) return Snapshot(null, null, null)
            return Snapshot(
                prefs.getString(KEY_SYSTEM_KEY, null),
                prefs.getString(KEY_SYSTEM_NAME, null),
                prefs.getString(KEY_API_URL, null),
            ).also { snapshot = it }
        }
    }

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = SecurePrefs.createOrFallback(context, PREFS, "system_session_init")
    }

    fun save(key: String, name: String, apiUrl: String) {
        val url = apiUrl.trimEnd('/') + "/"
        prefs.edit()
            .putString(KEY_SYSTEM_KEY, key)
            .putString(KEY_SYSTEM_NAME, name)
            .putString(KEY_API_URL, url)
            .commit()
        synchronized(this) { snapshot = Snapshot(key, name, url) }
    }

    fun systemKey(): String? = current().key
    fun systemName(): String? = current().name
    fun isSet(): Boolean = current().key != null && current().apiUrl != null

    /** Always ends in "/" (Retrofit's rule for a base URL). */
    fun apiBaseUrl(): String = current().apiUrl ?: NO_SYSTEM_URL
}
