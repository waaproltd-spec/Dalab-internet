package com.dalab.internet.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
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

    var readSmsGranted by remember { mutableStateOf(granted(Manifest.permission.READ_SMS)) }
    var receiveSmsGranted by remember { mutableStateOf(granted(Manifest.permission.RECEIVE_SMS)) }
    var serviceActive by remember { mutableStateOf(AgentBackgroundService.isRunning) }

    fun refresh() {
        readSmsGranted = granted(Manifest.permission.READ_SMS)
        receiveSmsGranted = granted(Manifest.permission.RECEIVE_SMS)
        serviceActive = AgentBackgroundService.isRunning
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
                "The automatic payment-detection pipeline needs all three of these " +
                    "to keep working, even when the app is minimized or the screen is locked.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(20.dp))

            PermissionStatusRow("READ_SMS Permission", readSmsGranted, "Granted", "Not Granted")
            Spacer(Modifier.height(12.dp))
            PermissionStatusRow("RECEIVE_SMS Permission", receiveSmsGranted, "Granted", "Not Granted")
            Spacer(Modifier.height(12.dp))
            PermissionStatusRow("Foreground Service", serviceActive, "Active", "Inactive")

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
private fun PermissionStatusRow(label: String, ok: Boolean, okLabel: String, notOkLabel: String) {
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
            Text(label, modifier = Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
            Text(if (ok) okLabel else notOkLabel, color = color, fontWeight = FontWeight.Bold)
        }
    }
}
