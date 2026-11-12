package com.dalab.internet.diagnostics

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.sms.SmsFingerprintStore
import com.dalab.internet.sms.SmsListenerState
import com.dalab.internet.ussd.ExchangeUssdBridge
import com.dalab.internet.ussd.ResellerWithdrawalInteractiveUssdBridge

/**
 * The automation-health readings sent with every heartbeat, so the Admin
 * Dashboard can tell "the phone is online" apart from "the phone can
 * actually do its job": SMS permission, unsent SMS and how old the oldest
 * is, last server-acknowledged SMS upload, Accessibility services, battery
 * optimisation, notification and phone permissions, service start time and
 * app version. Every reading is best-effort and never throws -- a failed
 * one is sent as null ("unknown"), never as a healthy value.
 */
object DeviceHealthSnapshot {
    data class Readings(
        val smsPermission: Boolean?,
        val pendingSmsCount: Int?,
        val oldestPendingSmsAgeSec: Long?,
        val pendingActionCount: Int?,
        val lastSmsUploadAt: Long?,
        val accessibilityResellerEnabled: Boolean?,
        val accessibilityExchangeEnabled: Boolean?,
        val batteryOptimizationIgnored: Boolean?,
        val notificationsEnabled: Boolean?,
        val phonePermission: Boolean?,
        val appVersion: String?,
    )

    fun read(context: Context, now: Long = System.currentTimeMillis()): Readings {
        val queue = safe { PendingActionQueue.all() }
        val pendingSms = queue?.filter { it.type == PendingActionQueue.Type.SMS_UPLOAD }
        return Readings(
            smsPermission = safe { SmsListenerState.hasSmsPermissions(context) },
            pendingSmsCount = pendingSms?.size,
            oldestPendingSmsAgeSec = pendingSms?.minOfOrNull { it.createdAt }?.let { (now - it).coerceAtLeast(0L) / 1000 },
            pendingActionCount = queue?.size,
            lastSmsUploadAt = safe { SmsFingerprintStore.lastAckAt() }?.takeIf { it > 0L },
            accessibilityResellerEnabled = safe { ResellerWithdrawalInteractiveUssdBridge.isAccessibilityServiceEnabled(context) },
            accessibilityExchangeEnabled = safe { ExchangeUssdBridge.isAccessibilityServiceEnabled(context) },
            batteryOptimizationIgnored = safe {
                (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isIgnoringBatteryOptimizations(context.packageName)
            },
            notificationsEnabled = safe { NotificationManagerCompat.from(context).areNotificationsEnabled() },
            phonePermission = safe {
                listOf(Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE).all {
                    ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
                }
            },
            appVersion = safe {
                val info = context.packageManager.getPackageInfo(context.packageName, 0)
                val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
                "${info.versionName} ($code)"
            },
        )
    }

    private inline fun <T> safe(block: () -> T?): T? = try {
        block()
    } catch (_: Exception) {
        null
    }
}
