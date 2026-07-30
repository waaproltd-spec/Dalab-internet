package com.dalab.internet.diagnostics

import android.content.Context
import android.content.SharedPreferences

/**
 * Running success/failure counters for the ~60s heartbeat tick
 * (AgentBackgroundService.heartbeatLoop), persisted so they survive a
 * process restart — the Reliability Dashboard reads these directly rather
 * than reconstructing them from DiagnosticsLog, which is capped and mixes
 * in unrelated entries (queue drops, sweep failures, etc.).
 */
object HeartbeatStats {
    private const val PREFS = "dalab_agent_heartbeat_stats"
    private const val KEY_SUCCESS_COUNT = "success_count"
    private const val KEY_FAILURE_COUNT = "failure_count"
    private const val KEY_LAST_SUCCESS_AT = "last_success_at"
    private const val KEY_LAST_FAILURE_AT = "last_failure_at"
    private const val KEY_LAST_ERROR = "last_error"

    private lateinit var prefs: SharedPreferences

    @Synchronized
    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    @Synchronized
    fun recordSuccess() {
        prefs.edit()
            .putInt(KEY_SUCCESS_COUNT, successCount() + 1)
            .putLong(KEY_LAST_SUCCESS_AT, System.currentTimeMillis())
            .remove(KEY_LAST_ERROR)
            .apply()
    }

    @Synchronized
    fun recordFailure(error: String?) {
        prefs.edit()
            .putInt(KEY_FAILURE_COUNT, failureCount() + 1)
            .putLong(KEY_LAST_FAILURE_AT, System.currentTimeMillis())
            .putString(KEY_LAST_ERROR, error?.take(500))
            .apply()
    }

    fun successCount(): Int = prefs.getInt(KEY_SUCCESS_COUNT, 0)
    fun failureCount(): Int = prefs.getInt(KEY_FAILURE_COUNT, 0)
    fun lastSuccessAt(): Long? = prefs.getLong(KEY_LAST_SUCCESS_AT, -1).takeIf { it >= 0 }
    fun lastFailureAt(): Long? = prefs.getLong(KEY_LAST_FAILURE_AT, -1).takeIf { it >= 0 }
    fun lastError(): String? = prefs.getString(KEY_LAST_ERROR, null)
}
