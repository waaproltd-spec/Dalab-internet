package com.dalab.internet.ui

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.BatteryAlert
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.dalab.internet.service.AgentBackgroundService

/**
 * Live status of the two SMS permissions and the background foreground
 * service that keep the automatic payment-detection pipeline (SmsReceiver
 * -> SmsUploadFlow -> backend, unchanged by this screen) running even when
 * the app is minimized or the screen is locked — plus a manual re-check and
 * a shortcut to the system app-settings page for fixing a denied permission.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PermissionsStatusScreen(onBack: () -> Unit) {
    val context = LocalContext.current

    fun granted(permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    fun batteryUnrestricted(): Boolean {
        val powerManager = context.getSystemService(PowerManager::class.java) ?: return true
        return powerManager.isIgnoringBatteryOptimizations(context.packageName)
    }

    val oemAutostartIntent = remember { resolveOemAutostartIntent(context) }

    var readSmsGranted by remember { mutableStateOf(granted(Manifest.permission.READ_SMS)) }
    var receiveSmsGranted by remember { mutableStateOf(granted(Manifest.permission.RECEIVE_SMS)) }
    var serviceActive by remember { mutableStateOf(AgentBackgroundService.isRunning) }
    var batteryExempt by remember { mutableStateOf(batteryUnrestricted()) }

    fun refresh() {
        readSmsGranted = granted(Manifest.permission.READ_SMS)
        receiveSmsGranted = granted(Manifest.permission.RECEIVE_SMS)
        serviceActive = AgentBackgroundService.isRunning
        batteryExempt = batteryUnrestricted()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Permissions") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(20.dp)
                .fillMaxSize(),
        ) {
            Text(
                "Real-time SMS reading and reliable background operation require these system " +
                    "permissions, so the app can detect payment confirmation messages from 192, " +
                    "Somtel, Somnet, and Amtel the instant they arrive — even when the app is " +
                    "minimized or the screen is locked.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(20.dp))

            PermissionStatusRow(
                "READ_SMS Permission", readSmsGranted, "Granted", "Not Granted",
                description = "Allows reading payment confirmation messages from 192, Somtel, Somnet, Amtel",
            )
            Spacer(Modifier.height(12.dp))
            PermissionStatusRow(
                "RECEIVE_SMS Permission", receiveSmsGranted, "Granted", "Not Granted",
                description = "Triggers immediate processing as soon as SMS arrives",
            )
            Spacer(Modifier.height(12.dp))
            PermissionStatusRow(
                "Foreground Service", serviceActive, "Active", "Inactive",
                description = "Keeps agent listener active in background even when app is minimized",
            )
            Spacer(Modifier.height(12.dp))
            PermissionStatusRow(
                "Battery Optimization", batteryExempt, "Unrestricted", "Restricted",
                description = "Stops Android from killing the background listener to save power",
            )
            if (!batteryExempt) {
                Spacer(Modifier.height(8.dp))
                Text(
                    "Without this, Android may stop payment monitoring after a few minutes " +
                        "in the background. Tap below to allow DALAB Agent to run unrestricted — " +
                        "the system will ask you to confirm.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                                data = Uri.parse("package:${context.packageName}")
                            }
                            context.startActivity(intent)
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Filled.BatteryAlert, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Disable Battery Optimization")
                }
            }

            // Standard Android battery-optimization exemption above only covers
            // Android's own Doze/App-Standby system. Several major manufacturers
            // (Xiaomi/Redmi/POCO, Huawei/Honor, Oppo/Realme, Vivo, and Transsion's
            // Tecno/Infinix/itel — all common in this market) ship a SEPARATE,
            // more aggressive background-app killer on top of stock Android that
            // the standard exemption does NOT disable. This is the most common
            // real-world reason a background SMS listener works once (while the
            // app was recently open/foregrounded) and then silently stops
            // reacting to further incoming SMS once the OS decides to kill it —
            // with no crash, no error, nothing in Diagnostics to explain it.
            if (oemAutostartIntent != null) {
                Spacer(Modifier.height(12.dp))
                Text(
                    "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} devices have their own separate battery/app manager " +
                        "that can silently stop background SMS monitoring even with battery optimization above disabled. " +
                        "Find DALAB Agent in the screen that opens and allow \"Auto-start\" / remove it from any \"Protected\"/restricted list.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedButton(
                    onClick = {
                        try {
                            context.startActivity(oemAutostartIntent)
                        } catch (_: ActivityNotFoundException) {
                            // Not present on this exact ROM/version — fall back to
                            // general app settings rather than crashing the screen.
                            try {
                                context.startActivity(
                                    Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                        data = Uri.fromParts("package", context.packageName, null)
                                    }
                                )
                            } catch (_: ActivityNotFoundException) {
                                // Nothing more we can do — avoid crashing either way.
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Filled.Settings, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Allow Auto-start / Remove Background Restrictions")
                }
            }

            Spacer(Modifier.weight(1f))

            Button(onClick = { refresh() }, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Re-check System Permissions")
            }
            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = {
                    val intent = Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = Uri.fromParts("package", context.packageName, null)
                    }
                    context.startActivity(intent)
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.Settings, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Open App Settings")
            }
        }
    }
}

@Composable
private fun PermissionStatusRow(label: String, ok: Boolean, okLabel: String, notOkLabel: String, description: String? = null) {
    val color = if (ok) Color(0xFF16A34A) else Color(0xFFDC2626)
    Surface(
        color = color.copy(alpha = 0.08f),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (ok) Icons.Filled.CheckCircle else Icons.Filled.Cancel,
                contentDescription = null,
                tint = color,
                modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(label, fontWeight = FontWeight.SemiBold)
                if (description != null) {
                    Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Text(if (ok) okLabel else notOkLabel, color = color, fontWeight = FontWeight.Bold)
        }
    }
}

/**
 * Well-known (but ROM-version-fragile, hence the try/catch at every call
 * site) component names for each major manufacturer's own background-app/
 * auto-start manager — a layer of restriction ADDITIONAL to and separate
 * from stock Android's battery optimization, which
 * ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS does not touch. Returns null
 * (hides the section entirely) on a manufacturer with no known screen for
 * this, rather than guessing at a component that doesn't exist.
 */
internal fun resolveOemAutostartIntent(context: Context): Intent? {
    val candidates: List<Pair<String, String>> = when (Build.MANUFACTURER.lowercase()) {
        "xiaomi" -> listOf("com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity")
        "huawei", "honor" -> listOf(
            "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager" to "com.huawei.systemmanager.optimize.process.ProtectActivity",
        )
        "oppo", "realme" -> listOf(
            "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
        )
        "vivo" -> listOf("com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")
        "transsion", "tecno", "infinix", "itel" -> listOf(
            "com.transsion.phonemanager" to "com.transsion.phonemanager.MainActivity",
        )
        "samsung" -> listOf("com.samsung.android.lool" to "com.samsung.android.sm.ui.battery.BatteryActivity")
        else -> emptyList()
    }
    for ((pkg, cls) in candidates) {
        val intent = Intent().apply {
            component = ComponentName(pkg, cls)
        }
        if (intent.resolveActivity(context.packageManager) != null) return intent
    }
    return null
}
