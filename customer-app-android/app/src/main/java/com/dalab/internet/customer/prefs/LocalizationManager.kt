package com.dalab.internet.customer.prefs

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.mutableStateOf

enum class AppLanguage(val code: String, val displayName: String) {
    ENGLISH("en", "English"),
    SOMALI("so", "Somali"),
}

/**
 * Persists the customer's chosen display language across restarts. Backed
 * by a real Compose [mutableStateOf] (unlike SessionManager's plain vars)
 * because a language change needs to redraw the whole app immediately,
 * not just on the next screen visit.
 *
 * [tr] currently covers the app's chrome — bottom navigation, the Home
 * header, Settings, Notifications, and the Profile menu — rather than
 * every screen in the app; most package/plan content already comes from
 * the backend in mixed English/Somali as seeded, and translating every
 * existing screen's copy is a larger follow-up beyond this pass.
 */
object LocalizationManager {
    private const val PREFS_NAME = "dalab_customer_prefs"
    private const val KEY_LANGUAGE = "language_code"

    private lateinit var prefs: SharedPreferences
    val languageState = mutableStateOf(AppLanguage.ENGLISH)
    val language: AppLanguage get() = languageState.value

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val savedCode = prefs.getString(KEY_LANGUAGE, AppLanguage.ENGLISH.code)
        languageState.value = AppLanguage.entries.find { it.code == savedCode } ?: AppLanguage.ENGLISH
    }

    fun setLanguage(value: AppLanguage) {
        languageState.value = value
        prefs.edit().putString(KEY_LANGUAGE, value.code).apply()
    }

    /** Looks up [en]/[so] based on the current language — call as `tr("Home", "Guriga")`. */
    fun tr(en: String, so: String): String = if (language == AppLanguage.SOMALI) so else en
}
