package com.dalab.internet.auth

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import java.util.UUID

/**
 * This app installation's own random id, sent with every request as
 * X-Agent-Install-Id. It's what Device Activation approves: a reinstall or
 * a new phone is a new install and needs its own approval. Not a hardware
 * id -- nothing about the phone itself is read.
 */
object DeviceInstall {
    const val HEADER = "X-Agent-Install-Id"
    private const val PREFS = "dalab_agent_install"
    private const val KEY_ID = "install_id"

    @Volatile private var cached: String? = null
    private var prefs: SharedPreferences? = null

    fun init(context: Context) {
        if (prefs != null) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        id()
    }

    /** Created once on first use, then the same for the life of this install. */
    fun id(): String {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val p = prefs
            val existing = p?.getString(KEY_ID, null)
            val value = existing ?: UUID.randomUUID().toString().replace("-", "")
            if (existing == null) p?.edit()?.putString(KEY_ID, value)?.apply()
            if (p != null) cached = value
            return value
        }
    }

    val deviceModel: String
        get() = listOf(Build.MANUFACTURER, Build.MODEL).filter { !it.isNullOrBlank() }
            .joinToString(" ") { it.replaceFirstChar { c -> c.uppercase() } }
            .take(120)
}
