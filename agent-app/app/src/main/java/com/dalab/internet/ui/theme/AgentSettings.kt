package com.dalab.internet.ui.theme

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** The app's display language. */
enum class AgentLanguage(val code: String) { ENGLISH("en"), SOMALI("so") }

/**
 * The agent's display preferences -- theme color, language (English /
 * Soomaali) and Agent Support sounds -- chosen under More and kept across
 * restarts. They're Compose state, so a change redraws every screen at
 * once, with no restart.
 */
object AgentSettings {
    private const val PREFS = "dalab_agent_display"
    private const val KEY_LANGUAGE = "language"
    private const val KEY_ACCENT = "accent"
    private const val KEY_SUPPORT_SOUNDS = "support_sounds"

    private var prefs: SharedPreferences? = null

    var language by mutableStateOf(AgentLanguage.ENGLISH)
        private set
    var accent by mutableStateOf(AgentAccent.DALAB_NAVY)
        private set

    /** Agent Support message/help-request sounds (More → Notifications). */
    var supportSounds by mutableStateOf(true)
        private set

    fun init(context: Context) {
        if (prefs != null) return
        val p = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs = p
        language = AgentLanguage.entries.firstOrNull { it.code == p.getString(KEY_LANGUAGE, null) } ?: AgentLanguage.ENGLISH
        accent = AgentAccent.entries.firstOrNull { it.name == p.getString(KEY_ACCENT, null) } ?: AgentAccent.DALAB_NAVY
        supportSounds = p.getBoolean(KEY_SUPPORT_SOUNDS, true)
    }

    fun updateLanguage(language: AgentLanguage) {
        this.language = language
        prefs?.edit()?.putString(KEY_LANGUAGE, language.code)?.apply()
    }

    fun updateAccent(accent: AgentAccent) {
        this.accent = accent
        prefs?.edit()?.putString(KEY_ACCENT, accent.name)?.apply()
    }

    fun updateSupportSounds(enabled: Boolean) {
        supportSounds = enabled
        prefs?.edit()?.putBoolean(KEY_SUPPORT_SOUNDS, enabled)?.apply()
    }
}
