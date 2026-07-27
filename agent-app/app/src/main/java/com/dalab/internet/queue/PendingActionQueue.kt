package com.dalab.internet.queue

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

/**
 * Durable queue for outbound actions that failed only because the device was
 * offline — not actions the server actually rejected. Backed by
 * EncryptedSharedPreferences (the androidx.security:security-crypto dependency
 * was already declared but never wired up anywhere in the app) since queued
 * items carry payment-related data: SMS bodies, phone numbers, order ids.
 *
 * Deliberately excludes heartbeats — see AgentBackgroundService — a stale
 * battery/SIM-presence snapshot replayed minutes late is misleading, not
 * useful, so heartbeat failures just self-heal on the next 60s tick instead
 * of going through this queue.
 */
object PendingActionQueue {
    private const val PREFS = "dalab_agent_pending_queue"
    private const val KEY_ITEMS = "items"
    private const val MAX_ITEMS = 200

    enum class Type { SMS_UPLOAD, VERIFY_PAYMENT, DIAL_ATTEMPT_AUDIT }

    data class PendingAction(
        val id: String,
        val type: Type,
        val payloadJson: String,
        val createdAt: Long,
        val attemptCount: Int = 0,
        val lastError: String? = null,
    )

    private lateinit var prefs: SharedPreferences
    private val gson = Gson()
    private val listType = object : TypeToken<MutableList<PendingAction>>() {}.type

    @Synchronized
    fun init(context: Context) {
        if (::prefs.isInitialized) return
        val masterKey = MasterKey.Builder(context.applicationContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        prefs = EncryptedSharedPreferences.create(
            context.applicationContext,
            PREFS,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    @Synchronized
    private fun readAll(): MutableList<PendingAction> {
        val json = prefs.getString(KEY_ITEMS, null) ?: return mutableListOf()
        return try {
            gson.fromJson(json, listType) ?: mutableListOf()
        } catch (_: Exception) {
            mutableListOf()
        }
    }

    @Synchronized
    private fun writeAll(items: List<PendingAction>) {
        prefs.edit().putString(KEY_ITEMS, gson.toJson(items)).apply()
    }

    @Synchronized
    fun enqueue(id: String, type: Type, payload: Any) {
        val items = readAll()
        items.add(PendingAction(id = id, type = type, payloadJson = gson.toJson(payload), createdAt = System.currentTimeMillis()))
        // Oldest items beyond the cap are dropped rather than growing forever
        // if the device stays offline a very long time — the caller logs the
        // drop to DiagnosticsLog rather than this silently losing data.
        val trimmed = if (items.size > MAX_ITEMS) items.takeLast(MAX_ITEMS) else items
        writeAll(trimmed)
    }

    @Synchronized
    fun all(): List<PendingAction> = readAll()

    @Synchronized
    fun remove(id: String) {
        writeAll(readAll().filterNot { it.id == id })
    }

    @Synchronized
    fun markAttempt(id: String, error: String?) {
        writeAll(readAll().map {
            if (it.id == id) it.copy(attemptCount = it.attemptCount + 1, lastError = error) else it
        })
    }

    inline fun <reified T> payloadOf(action: PendingAction): T = Gson().fromJson(action.payloadJson, T::class.java)
}
