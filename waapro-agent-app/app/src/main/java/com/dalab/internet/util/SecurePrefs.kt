package com.dalab.internet.util

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.dalab.internet.diagnostics.DiagnosticsLog

/**
 * EncryptedSharedPreferences.create() is a documented source of real-device
 * exceptions — a stale/invalidated Android Keystore key after an
 * uninstall+reinstall, a corrupted encrypted prefs file, OEM keystore quirks
 * (see DalabAgentApp's own header comment on this). Every prior caller of
 * this pattern (SessionManager, PendingActionQueue) called it once, directly,
 * with no recovery path — DalabAgentApp.onCreate()'s initSafely() isolates a
 * failure there from crashing the whole app, but doesn't fix it: `prefs`
 * stays permanently uninitialized for the rest of the process's life, so
 * every later read/write throws UninitializedPropertyAccessException
 * ("lateinit property prefs has not been initialized") — confirmed live on
 * SessionManager, where this makes EVERY network call fail forever (its
 * accessToken() is read by ApiClient's auth interceptor on every request),
 * effectively bricking the app until a full data clear/reinstall.
 *
 * This tries once, and on failure wipes the specific corrupted prefs file
 * (deleteSharedPreferences) and retries once more — the old encrypted values
 * are unrecoverable either way once the Keystore key that decrypts them is
 * gone, so there's nothing lost by clearing and recreating. If the retry
 * also fails, falls back to a plain (unencrypted) SharedPreferences store
 * under the same name so the caller stays usable rather than permanently
 * broken — a degraded-but-working session beats one that can never
 * function again without the agent manually clearing app data.
 */
object SecurePrefs {
    fun createOrFallback(context: Context, name: String, diagnosticsTag: String): SharedPreferences {
        val appContext = context.applicationContext
        return try {
            createEncrypted(appContext, name)
        } catch (e: Exception) {
            logSafely(diagnosticsTag, "EncryptedSharedPreferences create failed for '$name', wiping and retrying: ${e.stackTraceToString().take(1000)}")
            appContext.deleteSharedPreferences(name)
            try {
                createEncrypted(appContext, name)
            } catch (e2: Exception) {
                logSafely(diagnosticsTag, "Retry also failed for '$name', falling back to plain storage: ${e2.stackTraceToString().take(1000)}")
                appContext.getSharedPreferences(name, Context.MODE_PRIVATE)
            }
        }
    }

    private fun createEncrypted(appContext: Context, name: String): SharedPreferences {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            appContext,
            name,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    // DiagnosticsLog.init() runs first and unconditionally in
    // DalabAgentApp.onCreate() (never wrapped in initSafely, since its own
    // getSharedPreferences() call is not a realistic throw site), so this is
    // safe in the ordinary startup path — this guard only covers a caller
    // that somehow runs before that, so a diagnostics-logging failure itself
    // can never mask or replace the real error being reported here.
    private fun logSafely(tag: String, message: String) {
        try {
            DiagnosticsLog.record(tag, message)
        } catch (_: Exception) {
        }
    }
}
