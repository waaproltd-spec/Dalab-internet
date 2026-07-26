package com.dalab.internet.sms

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import com.dalab.internet.data.SmsLogEntry

object SmsListenerState {
    private const val PREFS = "dalab_agent_sms"
    private const val KEY_LISTENING = "is_listening"

    private lateinit var prefs: SharedPreferences

    private val _isListening = MutableStateFlow(false)
    val isListening: StateFlow<Boolean> = _isListening.asStateFlow()

    private val _recentLogs = MutableStateFlow<List<SmsLogEntry>>(emptyList())
    val recentLogs: StateFlow<List<SmsLogEntry>> = _recentLogs.asStateFlow()

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        _isListening.value = prefs.getBoolean(KEY_LISTENING, false)
    }

    fun setListening(enabled: Boolean) {
        _isListening.value = enabled
        prefs.edit().putBoolean(KEY_LISTENING, enabled).apply()
    }

    fun recordLog(entry: SmsLogEntry) {
        _recentLogs.value = (listOf(entry) + _recentLogs.value).take(50)
    }
}
