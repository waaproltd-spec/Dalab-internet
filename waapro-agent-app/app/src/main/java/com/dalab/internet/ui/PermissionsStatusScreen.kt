package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
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
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.filled.BatteryChargingFull
import androidx.compose.material.icons.filled.MarkEmailUnread
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material.icons.filled.Sync
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.BatteryAlert
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

    val okCount = listOf(readSmsGranted, receiveSmsGranted, serviceActive, batteryExempt).count { it }

    Scaffold(
        topBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(WaaproHeaderBrush, RoundedCornerShape(bottomStart = 26.dp, bottomEnd = 26.dp))
                    .padding(start = 8.dp, end = 8.dp, top = 10.dp, bottom = 18.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                    Text("Permissions", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp, modifier = Modifier.weight(1f))
                    IconButton(onClick = { refresh() }) { Icon(Icons.Filled.Refresh, contentDescription = "Re-check", tint = Color.White) }
                }
                Spacer(Modifier.height(10.dp))
                Box(Modifier.padding(horizontal = 8.dp)) {
                    StatusBanner(if (okCount == 4) "All set · 4 of 4" else "$okCount of 4 ready", ok = okCount == 4)
                }
            }
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
        ) {
            StatusGrid(listOf<@Composable (Modifier) -> Unit>(
                { m -> StatusTile(Icons.Filled.Sms, "Read SMS", readSmsGranted, "Granted", "Not granted", m) },
                { m -> StatusTile(Icons.Filled.MarkEmailUnread, "Receive SMS", receiveSmsGranted, "Granted", "Not granted", m) },
                { m -> StatusTile(Icons.Filled.Sync, "Background service", serviceActive, "Active", "Inactive", m) },
                { m -> StatusTile(Icons.Filled.BatteryChargingFull, "Battery", batteryExempt, "Unrestricted", "Restricted", m) },
            ))

            if (!batteryExempt) {
                Spacer(Modifier.height(14.dp))
                Button(
                    onClick = {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                                data = Uri.parse("package:${context.packageName}")
                            }
                            context.startActivity(intent)
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = StatusRed),
                    shape = RoundedCornerShape(16.dp),
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                ) {
                    Icon(Icons.Filled.BatteryAlert, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Allow unrestricted battery", fontWeight = FontWeight.Bold)
                }
            }

            // Several manufacturers (Xiaomi, Huawei/Honor, Oppo/Realme, Vivo,
            // Tecno/Infinix/itel, Samsung) have their own background-app
            // killer on top of Android's battery optimization; the exemption
            // above does not cover it. This opens that maker's own screen.
            if (oemAutostartIntent != null) {
                Spacer(Modifier.height(12.dp))
                OutlinedButton(
                    onClick = {
                        try {
                            context.startActivity(oemAutostartIntent)
                        } catch (_: ActivityNotFoundException) {
                            try {
                                context.startActivity(
                                    Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                        data = Uri.fromParts("package", context.packageName, null)
                                    }
                                )
                            } catch (_: ActivityNotFoundException) {
                                // Nothing more we can do.
                            }
                        }
                    },
                    shape = RoundedCornerShape(16.dp),
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                ) {
                    Icon(Icons.Filled.Settings, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} auto-start", fontWeight = FontWeight.Bold)
                }
            }

            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = {
                    val intent = Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = Uri.fromParts("package", context.packageName, null)
                    }
                    context.startActivity(intent)
                },
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth().height(52.dp),
            ) {
                Icon(Icons.Filled.Settings, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("App settings", fontWeight = FontWeight.Bold)
            }
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
