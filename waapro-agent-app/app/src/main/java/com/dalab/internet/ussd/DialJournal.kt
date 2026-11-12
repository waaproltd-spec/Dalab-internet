package com.dalab.internet.ussd

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

/**
 * "A carrier dial for this order was started on this phone and its result
 * hasn't been recorded yet." Written BEFORE the USSD request is sent and
 * cleared once its result is reported (online, or saved for a queued
 * replay). If the app dies mid-dial, the next attempt for that order finds
 * the entry and reports the dial as outcome-unknown instead of dialing again
 * -- the money may already have gone out, so it must be checked first.
 * Holds no PINs and no dial strings beyond what the audit replay needs.
 */
object DialJournal {
    private const val PREFS = "dalab_agent_dial_journal"
    private const val KEY = "entries"

    data class Entry(
        val orderId: String,
        val attemptId: String?,
        val attemptNumber: Int,
        val simSlot: Int,
        // The masked summary the server generated (one-shot strings carry
        // the PIN, so only the attempt id is needed to report it).
        val startedAt: Long,
    )

    private val gson = Gson()
    private val type = object : TypeToken<MutableMap<String, Entry>>() {}.type

    @Synchronized
    private fun load(context: Context): MutableMap<String, Entry> {
        val json = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
            ?: return mutableMapOf()
        return try {
            gson.fromJson<MutableMap<String, Entry>>(json, type) ?: mutableMapOf()
        } catch (_: Exception) {
            mutableMapOf()
        }
    }

    @Synchronized
    private fun save(context: Context, entries: Map<String, Entry>) {
        // commit(), not apply(): this must be on disk before the dial starts.
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY, gson.toJson(entries)).commit()
    }

    @Synchronized
    fun begin(context: Context, entry: Entry) {
        val entries = load(context)
        entries[entry.orderId] = entry
        save(context, entries)
    }

    @Synchronized
    fun get(context: Context, orderId: String): Entry? = load(context)[orderId]

    @Synchronized
    fun clear(context: Context, orderId: String) {
        val entries = load(context)
        if (entries.remove(orderId) != null) save(context, entries)
    }
}
