package com.dalab.internet.ussd

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * USSD sessions whose result is UNKNOWN and that therefore must be checked
 * by a person -- never dialed again automatically:
 *  - a session that hit the global queue's time limit ([UssdSimLock]);
 *  - an Internet Store dial that was in progress when the app stopped
 *    (still in [DialJournal] when the app comes back).
 * Kept on disk so they survive losing the internet or the app restarting.
 * Display only: nothing here changes how any order is processed.
 */
object UncertainUssdJobs {
    private const val PREFS = "agent_uncertain_ussd"
    private const val KEY = "entries"
    private const val MAX = 20

    data class Entry(val key: String, val label: String, val simSlot: Int, val atMs: Long, val reason: String)

    private val gson = Gson()
    private val type = object : TypeToken<List<Entry>>() {}.type
    private var appContext: Context? = null
    private val _entries = MutableStateFlow<List<Entry>>(emptyList())
    val entries: StateFlow<List<Entry>> = _entries.asStateFlow()

    fun init(context: Context) {
        appContext = context.applicationContext
        _entries.value = load()
        // The queue reports a time-out here; it runs off the main thread.
        UssdSimLock.onSessionTimeout = { e ->
            record(Entry(e.key, e.label, e.simSlot, e.sinceMs, REASON_TIMEOUT))
        }
    }

    /** Internet Store dials that were mid-flight when the app stopped. Not
     * the ones running right now (those are in [UssdJobRegistry]). */
    fun interruptedDials(context: Context, activeKeys: Set<String>): List<Entry> =
        DialJournal.all(context).values
            .filter { "internet_store:${it.orderId}" !in activeKeys }
            .map { Entry("internet_store:${it.orderId}", "Order ${it.orderId}", it.simSlot, it.startedAt, REASON_INTERRUPTED) }

    @Synchronized
    fun record(entry: Entry) {
        val list = (listOf(entry) + _entries.value.filter { it.key != entry.key }).take(MAX)
        save(list)
    }

    /** The agent checked it ("I checked this"). Only hides it from this list. */
    @Synchronized
    fun dismiss(key: String) {
        save(_entries.value.filter { it.key != key })
    }

    private fun load(): List<Entry> {
        val ctx = appContext ?: return emptyList()
        val json = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return emptyList()
        return try { gson.fromJson<List<Entry>>(json, type) ?: emptyList() } catch (_: Exception) { emptyList() }
    }

    private fun save(list: List<Entry>) {
        _entries.value = list
        appContext?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.putString(KEY, gson.toJson(list))?.apply()
    }

    const val REASON_TIMEOUT = "timeout"
    const val REASON_INTERRUPTED = "interrupted"
}
