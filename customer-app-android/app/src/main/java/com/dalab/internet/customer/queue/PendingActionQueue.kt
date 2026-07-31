package com.dalab.internet.customer.queue

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

/**
 * Durable queue for an order-creation attempt that failed only because the
 * device was offline — not one the server actually rejected. Backed by
 * EncryptedSharedPreferences (the androidx.security:security-crypto
 * dependency was already declared but never wired up anywhere in the app)
 * since a queued item carries order/payment data. Mirrors agent-app's
 * PendingActionQueue shape (no shared module exists between the two apps),
 * but only ever holds one action type — order creation — since that's the
 * only offline-safe action this customer-facing app has.
 */
object PendingActionQueue {
    private const val PREFS = "dalab_customer_pending_queue"
    private const val KEY_ITEMS = "items"
    private const val MAX_ITEMS = 50

    enum class Type { ORDER_CREATE }

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
        // This is a best-effort offline-retry cache, not the app's core purpose --
        // it must never be able to take down app startup. Falls back to a plain
        // (unencrypted) prefs file if the encrypted store can't initialize for any
        // reason on a given device/OS combination, instead of crashing before any
        // screen ever shows.
        prefs = try {
            val masterKey = MasterKey.Builder(context.applicationContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context.applicationContext,
                PREFS,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (_: Exception) {
            context.applicationContext.getSharedPreferences("${PREFS}_fallback", Context.MODE_PRIVATE)
        }
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
