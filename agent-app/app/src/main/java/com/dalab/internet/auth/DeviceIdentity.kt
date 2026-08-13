package com.dalab.internet.auth

import android.content.Context
import android.content.SharedPreferences

/**
 * Which `agent_devices` row this physical install has been registered as.
 * Separate from [SessionManager] (agent account credentials) because a
 * device's identity survives across different agents logging in/out on the
 * same physical phone, whereas the session doesn't. Everything that needs
 * to scope a call to "this device" (SIM routing, health heartbeats) reads
 * from here rather than guessing.
 */
object DeviceIdentity {
    private const val PREFS = "dalab_agent_device"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_DEVICE_NAME = "device_name"
    private const val KEY_PAYMENT_ROLE = "payment_role"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    fun set(deviceId: String, deviceName: String, paymentRole: String? = null) {
        prefs.edit()
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_DEVICE_NAME, deviceName)
            .putString(KEY_PAYMENT_ROLE, paymentRole)
            .apply()
    }

    fun deviceId(): String? = prefs.getString(KEY_DEVICE_ID, null)
    fun deviceName(): String? = prefs.getString(KEY_DEVICE_NAME, null)
    fun isSet(): Boolean = deviceId() != null

    /**
     * Admin > Mobile Management (agent_devices.payment_role). Refreshed
     * opportunistically from AgentBackgroundService's heartbeat cycle, so an
     * admin's role change reaches this device within about a minute without
     * requiring a re-run of device setup. Null (never synced yet, or the
     * device predates this field) is treated as unrestricted — same as the
     * backend's own "no role set" fallback.
     */
    fun paymentRole(): String? = prefs.getString(KEY_PAYMENT_ROLE, null)
    fun setPaymentRole(role: String?) {
        prefs.edit().putString(KEY_PAYMENT_ROLE, role).apply()
    }

    fun canSend(): Boolean = paymentRole() != "receive_only"
    fun canReceive(): Boolean = paymentRole() != "send_only"

    fun clear() {
        prefs.edit().clear().apply()
    }
}
