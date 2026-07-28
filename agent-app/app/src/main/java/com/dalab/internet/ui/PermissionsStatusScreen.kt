package com.dalab.internet.ui

import android.Manifest
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
