package com.dalab.internet.diagnostics

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build

/**
 * "isn't responding" (an ANR) kills the app without passing through the
 * crash handler, so nothing was recorded. On the next start, Android
 * (11+) still has the frozen moment's thread dump: the main thread's part
 * goes to Diagnostics, which the heartbeat sends to the server, so a
 * freeze can be traced to the exact line that blocked.
 */
object AnrRecorder {
    private const val PREFS = "anr_recorder"
    private const val KEY_LAST = "last_seen_ms"

    fun recordPastAnrs(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        try {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val lastSeen = prefs.getLong(KEY_LAST, 0L)
            val am = context.getSystemService(ActivityManager::class.java) ?: return
            val anrs = am.getHistoricalProcessExitReasons(context.packageName, 0, 10)
                .filter { it.reason == ApplicationExitInfo.REASON_ANR && it.timestamp > lastSeen }
                .sortedBy { it.timestamp }
            for (info in anrs) {
                val dump = try {
                    info.traceInputStream?.bufferedReader()?.use { it.readText() }
                } catch (_: Exception) {
                    null
                }
                DiagnosticsLog.record(
                    "anr",
                    "App not responding at ${java.util.Date(info.timestamp)}: ${info.description ?: ""}\n" +
                        (dump?.let { mainThreadPart(it) } ?: "(no thread dump)"),
                )
            }
            anrs.maxOfOrNull { it.timestamp }?.let { prefs.edit().putLong(KEY_LAST, it).apply() }
        } catch (e: Exception) {
            try {
                DiagnosticsLog.record("anr", "Couldn't read past freezes: ${e.javaClass.simpleName}: ${e.message}")
            } catch (_: Exception) {
            }
        }
    }

    /** The main thread's stack from a full thread dump (what was blocked). */
    internal fun mainThreadPart(dump: String): String {
        val start = dump.indexOf("\"main\"")
        if (start < 0) return dump.take(3500)
        val end = dump.indexOf("\n\n", start).takeIf { it > 0 } ?: dump.length
        return dump.substring(start, end).take(3500)
    }
}
