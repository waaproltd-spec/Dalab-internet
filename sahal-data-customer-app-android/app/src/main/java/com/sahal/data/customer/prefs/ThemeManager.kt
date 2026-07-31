package com.sahal.data.customer.prefs

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.mutableStateOf

enum class ThemeMode { LIGHT, DARK }

/**
 * Persists the customer's chosen Light/Dark mode across restarts. Backed
 * by a real Compose [mutableStateOf] so toggling it in Settings recolors
 * the whole app immediately, without needing to restart the activity.
 */
object ThemeManager {
    private const val PREFS_NAME = "sahal_data_customer_prefs"
    private const val KEY_THEME = "theme_mode"

    private lateinit var prefs: SharedPreferences
    val modeState = mutableStateOf(ThemeMode.LIGHT)
    val mode: ThemeMode get() = modeState.value
    val isDark: Boolean get() = modeState.value == ThemeMode.DARK

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(KEY_THEME, ThemeMode.LIGHT.name)
        modeState.value = runCatching { ThemeMode.valueOf(saved ?: ThemeMode.LIGHT.name) }.getOrDefault(ThemeMode.LIGHT)
    }

    fun setMode(value: ThemeMode) {
        modeState.value = value
        prefs.edit().putString(KEY_THEME, value.name).apply()
    }
}
