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
    // Open-ended prefix rather than a fixed set of keys - HeartbeatFailureClassifier
    // can emit categories like "http_404"/"http_500" for distinct status codes,
    // and SharedPreferences has no trouble holding however many of these show up.
    private const val KEY_CATEGORY_COUNT_PREFIX = "failure_count_"

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

    // Total failureCount() stays the source of truth for the Reliability
    // Dashboard's existing "Failed" line - the per-category counter is
    // purely additive detail, so a failure is never lost from the total
    // even for a category this app version doesn't otherwise recognize.
    @Synchronized
    fun recordFailure(category: String, error: String?) {
        val categoryKey = KEY_CATEGORY_COUNT_PREFIX + category
        prefs.edit()
            .putInt(KEY_FAILURE_COUNT, failureCount() + 1)
            .putInt(categoryKey, prefs.getInt(categoryKey, 0) + 1)
            .putLong(KEY_LAST_FAILURE_AT, System.currentTimeMillis())
            .putString(KEY_LAST_ERROR, error?.take(500))
            .apply()
    }

    fun successCount(): Int = prefs.getInt(KEY_SUCCESS_COUNT, 0)
    fun failureCount(): Int = prefs.getInt(KEY_FAILURE_COUNT, 0)
    fun lastSuccessAt(): Long? = prefs.getLong(KEY_LAST_SUCCESS_AT, -1).takeIf { it >= 0 }
    fun lastFailureAt(): Long? = prefs.getLong(KEY_LAST_FAILURE_AT, -1).takeIf { it >= 0 }
    fun lastError(): String? = prefs.getString(KEY_LAST_ERROR, null)

    fun failureCountsByCategory(): Map<String, Int> =
        prefs.all
            .filterKeys { it.startsWith(KEY_CATEGORY_COUNT_PREFIX) }
            .mapNotNull { (key, value) ->
                (value as? Int)?.let { key.removePrefix(KEY_CATEGORY_COUNT_PREFIX) to it }
            }
            .toMap()
}
