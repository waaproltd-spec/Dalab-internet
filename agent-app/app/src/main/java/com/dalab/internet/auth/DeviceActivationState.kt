package com.dalab.internet.auth

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.dalab.internet.MainActivity
import com.dalab.internet.R
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.DeviceActivationStatusRequest

/**
 * Whether this install is approved to use the Agent App (backend:
 * deviceActivation.routes.ts). The app only opens once the backend says
 * "approved"; every other state shows the Device Activation screen.
 *
 * "approved" is remembered on the phone so an approved device opens straight
 * away without a network round trip -- but the backend still checks every
 * request, and a 403 DEVICE_NOT_ACTIVATED (e.g. an admin revoked it) puts the
 * activation screen back immediately (see ApiClient).
 */
object DeviceActivationState {
    enum class Status { UNKNOWN, APPROVED, PENDING, REJECTED }

    private const val PREFS = "dalab_agent_activation"
    private const val KEY_APPROVED_FOR = "approved_for_agent"
    private const val KEY_DEVICE_NUMBER = "device_number"

    private const val CHANNEL_ID = "device_activation_v1"
    private const val NOTIFICATION_ID = 0x5A0A0001

    private var prefs: SharedPreferences? = null
    private var appContext: Context? = null

    var status by mutableStateOf(Status.UNKNOWN)
        private set
    var deviceNumber by mutableStateOf<String?>(null)
        private set
    var code by mutableStateOf<String?>(null)
        private set
    var codeExpiresAt by mutableStateOf<String?>(null)
        private set
    /** Last check failed to reach the server (no internet, timeout). */
    var connectionError by mutableStateOf(false)
        private set

    fun init(context: Context) {
        if (prefs != null) return
        appContext = context.applicationContext
        createChannel(context.applicationContext)
        val p = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs = p
        deviceNumber = p.getString(KEY_DEVICE_NUMBER, null)
        val agentId = currentAgentId()
        if (agentId != null && p.getString(KEY_APPROVED_FOR, null) == agentId) status = Status.APPROVED
    }

    val isApproved: Boolean get() = status == Status.APPROVED

    private fun currentAgentId(): String? = try {
        SessionManager.currentAgent()?.id
    } catch (_: Exception) {
        null
    }

    /** Asks the backend for the real status (the Check button, app start, polling). */
    suspend fun refresh(): Status {
        return try {
            val response = ApiClient.service.getDeviceActivationStatus(
                DeviceActivationStatusRequest(DeviceInstall.id(), DeviceInstall.deviceModel, DeviceIdentity.deviceId()),
            )
            val body = response.body()
            if (!response.isSuccessful || body == null) {
                connectionError = response.code() >= 500
                DiagnosticsLog.record("device_activation", "Status check failed: HTTP ${response.code()}")
                return status
            }
            connectionError = false
            body.deviceNumber?.let {
                deviceNumber = it
                prefs?.edit()?.putString(KEY_DEVICE_NUMBER, it)?.apply()
            }
            code = body.code
            codeExpiresAt = body.codeExpiresAt
            status = when (body.status) {
                "approved" -> Status.APPROVED
                "rejected" -> Status.REJECTED
                else -> Status.PENDING
            }
            prefs?.edit()?.putString(KEY_APPROVED_FOR, if (status == Status.APPROVED) currentAgentId() else null)?.apply()
            if (status == Status.APPROVED) cancelNotification()
            status
        } catch (e: Exception) {
            connectionError = true
            DiagnosticsLog.record("device_activation", "Status check failed: ${e.message}")
            status
        }
    }

    /** The backend refused a request because this device isn't activated (any more). */
    fun markNotActivated() {
        if (status == Status.APPROVED || status == Status.UNKNOWN) {
            status = Status.PENDING
            code = null
            prefs?.edit()?.remove(KEY_APPROVED_FOR)?.apply()
            // The background service hits this while the app is closed: tell
            // the agent, otherwise the phone just stops working silently and
            // never shows its code (the code only appears with the app open).
            notifyActivationRequired()
        }
    }

    private fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Device activation", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "This phone needs admin approval before it can process orders"
            },
        )
    }

    private fun notifyActivationRequired() {
        val context = appContext ?: return
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context, NOTIFICATION_ID, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val text = "Open DALAB Agent to see this phone's activation code, then ask an admin to approve it."
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Device activation required")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            DiagnosticsLog.record("device_activation", "Missing POST_NOTIFICATIONS: ${e.message}")
        }
    }

    private fun cancelNotification() {
        val context = appContext ?: return
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }

    /** Logged out / switched account: the next agent's approval is checked fresh. */
    fun reset() {
        status = Status.UNKNOWN
        code = null
        codeExpiresAt = null
        prefs?.edit()?.remove(KEY_APPROVED_FOR)?.apply()
    }
}
