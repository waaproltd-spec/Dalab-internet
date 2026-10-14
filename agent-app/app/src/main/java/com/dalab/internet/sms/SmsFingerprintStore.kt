package com.dalab.internet.sms

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

/**
 * Persists [SmsIntakeLedger] so "which SMS has the server already
 * acknowledged" survives process death and reboots -- that is what lets the
 * inbox recovery re-read an overlapping window every time without uploading
 * the same SMS again. Holds only SHA-256 fingerprints and timestamps, never
 * SMS text.
 */
object SmsFingerprintStore {
    private const val PREFS = "dalab_agent_sms_ledger"
    private const val KEY = "entries"

    private val gson = Gson()
    private val type = object : TypeToken<MutableMap<String, SmsIntakeLedger.Entry>>() {}.type
    private var prefs: SharedPreferences? = null

    @Synchronized
    fun init(context: Context) {
        if (prefs == null) prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    @Synchronized
    private fun load(): SmsIntakeLedger {
        val json = prefs?.getString(KEY, null) ?: return SmsIntakeLedger()
        return try {
            SmsIntakeLedger(gson.fromJson<MutableMap<String, SmsIntakeLedger.Entry>>(json, type) ?: mutableMapOf())
        } catch (_: Exception) {
            // A corrupt ledger only costs re-uploads, which the server
            // dedups -- never a lost or doubled payment.
            SmsIntakeLedger()
        }
    }

    @Synchronized
    private fun save(ledger: SmsIntakeLedger) {
        ledger.prune(System.currentTimeMillis())
        prefs?.edit()?.putString(KEY, gson.toJson(ledger.snapshot()))?.apply()
    }

    @Synchronized
    fun state(fingerprint: String): SmsIntakeLedger.State? = load().state(fingerprint)

    @Synchronized
    fun isAcked(fingerprint: String): Boolean = state(fingerprint) == SmsIntakeLedger.State.ACKED

    @Synchronized
    fun markQueued(fingerprint: String) {
        val ledger = load()
        ledger.markQueued(fingerprint, System.currentTimeMillis())
        save(ledger)
    }

    @Synchronized
    fun markAcked(fingerprint: String) {
        val ledger = load()
        ledger.markAcked(fingerprint, System.currentTimeMillis())
        save(ledger)
    }
}
