package com.dalab.internet.diagnostics

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

/**
 * Local, persisted record of recent failures across the automatic pipeline
 * (SMS upload, verify-payment, dial-attempt logging, queue drains, SIM
 * routing refresh) — previously these all failed into an empty catch block
 * with no visibility beyond Logcat. Not a replacement for the dashboard's
 * server-side execution logs — this is specifically what happened on THIS
 * device, including failures that never reached the server at all.
 */
object DiagnosticsLog {
    private const val PREFS = "dalab_agent_diagnostics"
    private const val KEY_ENTRIES = "entries"
    private const val KEY_SYNCED_UP_TO = "synced_up_to"
    private const val MAX_ENTRIES = 200
    private const val MAX_UPLOAD_BATCH = 20

    data class Entry(
        val timestamp: Long,
        val tag: String,
        val message: String,
        val isError: Boolean = true,
    )

    private lateinit var prefs: SharedPreferences
    private val gson = Gson()
    private val listType = object : TypeToken<MutableList<Entry>>() {}.type

    @Synchronized
    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    @Synchronized
    fun record(tag: String, message: String, isError: Boolean = true) {
        val entries = readAll()
        entries.add(0, Entry(System.currentTimeMillis(), tag, message, isError))
        writeAll(entries.take(MAX_ENTRIES))
    }

    /**
     * Called only from the process-wide uncaught-exception handler
     * ([com.dalab.internet.DalabAgentApp]) in the last moments before the
     * OS kills the process for an unhandled crash. Uses [commit] rather than
     * [record]'s [android.content.SharedPreferences.Editor.apply] — apply()
     * queues the write for later on a background thread, which a dying
     * process may never get to run; commit() blocks the crashing thread
     * until the write actually lands on disk, so the entry survives even
     * though the process is about to die.
     */
    @Synchronized
    fun recordFatal(threadName: String, throwable: Throwable) {
        if (!::prefs.isInitialized) return // AgentApplication.onCreate() always runs first; defensive only
        val trace = throwable.stackTraceToString().take(4000)
        val entries = readAll()
        entries.add(0, Entry(System.currentTimeMillis(), "FATAL CRASH", "Thread '$threadName': $trace", true))
        val json = gson.toJson(entries.take(MAX_ENTRIES))
        prefs.edit().putString(KEY_ENTRIES, json).commit()
    }

    @Synchronized
    fun all(): List<Entry> = readAll()

    @Synchronized
    fun clear() {
        prefs.edit().remove(KEY_ENTRIES).apply()
    }

    /**
     * Reliability Dashboard: entries not yet delivered to the backend,
     * oldest-unsynced-first (unlike [all]'s newest-first order) and capped
     * so a single heartbeat's payload stays small. Oldest-first matters:
     * [markSyncedUpTo] advances a single high-water-mark timestamp, so
     * skipping straight to the newest entries here would permanently strand
     * any older unsynced ones in the gap between the old and new mark.
     * "Delivered" only means "attached to a heartbeat call that itself
     * succeeded" — a device stuck offline just keeps accumulating locally.
     */
    @Synchronized
    fun unsyncedEntries(): List<Entry> {
        val syncedUpTo = prefs.getLong(KEY_SYNCED_UP_TO, 0)
        return readAll().filter { it.timestamp > syncedUpTo }.sortedBy { it.timestamp }.take(MAX_UPLOAD_BATCH)
    }

    @Synchronized
    fun markSyncedUpTo(timestamp: Long) {
        val current = prefs.getLong(KEY_SYNCED_UP_TO, 0)
        if (timestamp > current) prefs.edit().putLong(KEY_SYNCED_UP_TO, timestamp).apply()
    }

    private fun readAll(): MutableList<Entry> {
        val json = prefs.getString(KEY_ENTRIES, null) ?: return mutableListOf()
        return try {
            gson.fromJson(json, listType) ?: mutableListOf()
        } catch (_: Exception) {
            mutableListOf()
        }
    }

    private fun writeAll(entries: List<Entry>) {
        prefs.edit().putString(KEY_ENTRIES, gson.toJson(entries)).apply()
    }
}
