package com.dalab.internet.diagnostics

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.util.concurrent.Executors

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

    // Parsed once, then kept in memory: record() is called from the main
    // thread too (the accessibility services, Activity callbacks), and
    // re-parsing and re-serialising up to 200 entries on every call there
    // was a real contributor to "DALAB Agent isn't responding". The JSON
    // write happens on one background thread, coalesced.
    private var cache: MutableList<Entry>? = null
    private val writer = Executors.newSingleThreadExecutor { r -> Thread(r, "dalab-diagnostics-writer").apply { isDaemon = true } }
    @Volatile private var writeScheduled = false

    @Synchronized
    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    @Synchronized
    fun record(tag: String, message: String, isError: Boolean = true) {
        if (!::prefs.isInitialized) return
        val entries = readAll()
        entries.add(0, Entry(System.currentTimeMillis(), tag, message, isError))
        while (entries.size > MAX_ENTRIES) entries.removeAt(entries.size - 1)
        scheduleWrite()
    }

    private fun scheduleWrite() {
        if (writeScheduled) return
        writeScheduled = true
        writer.execute {
            val snapshot = synchronized(this) {
                writeScheduled = false
                cache?.toList()
            } ?: return@execute
            prefs.edit().putString(KEY_ENTRIES, gson.toJson(snapshot)).apply()
        }
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
        while (entries.size > MAX_ENTRIES) entries.removeAt(entries.size - 1)
        val json = gson.toJson(entries)
        prefs.edit().putString(KEY_ENTRIES, json).commit()
    }

    @Synchronized
    fun all(): List<Entry> = readAll().toList()

    @Synchronized
    fun clear() {
        cache = mutableListOf()
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

    /** The in-memory list (loaded from disk on first use). Callers hold
     * this object's lock. */
    private fun readAll(): MutableList<Entry> {
        cache?.let { return it }
        val json = prefs.getString(KEY_ENTRIES, null)
        val loaded: MutableList<Entry> = if (json == null) mutableListOf() else try {
            gson.fromJson<MutableList<Entry>>(json, listType) ?: mutableListOf()
        } catch (_: Exception) {
            mutableListOf()
        }
        cache = loaded
        return loaded
    }
}
