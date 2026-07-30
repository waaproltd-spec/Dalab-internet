package com.dalab.internet.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BatteryAlert
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * Shown once per app launch — right after login/device-setup, before HOME —
 * whenever battery-optimization exemption hasn't been granted yet. This is
 * the #1 real-world cause of "no heartbeat in over 5 minutes" / SMS
 * monitoring silently stopping (confirmed: the exemption already existed in
 * PermissionsStatusScreen, but was opt-in and buried under More > Permissions
 * with no proactive nudge — easy for an agent to never see). Unlike the SMS
 * permission gate, this can't be force-granted by an OS dialog alone, so this
 * screen nudges rather than hard-blocks: Continue always proceeds regardless
 * of whether the exemption was actually granted.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReliabilitySetupScreen(onContinue: () -> Unit) {
    val context = LocalContext.current

    fun batteryUnrestricted(): Boolean {
        val powerManager = context.getSystemService(PowerManager::class.java) ?: return true
        return powerManager.isIgnoringBatteryOptimizations(context.packageName)
    }

    var batteryExempt by remember { mutableStateOf(batteryUnrestricted()) }
    val oemAutostartIntent = remember { resolveOemAutostartIntent(context) }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Keep DALAB Agent Running") }) }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(20.dp)
                .fillMaxSize(),
        ) {
            Icon(Icons.Filled.Security, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(48.dp))
            Spacer(Modifier.height(12.dp))
            Text(
                "This device processes real payments around the clock — SMS monitoring, payment " +
                    "verification, and order delivery all need to keep running even with the screen " +
                    "off. Android's battery saver can silently pause that.",
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(20.dp))

            if (!batteryExempt) {
                Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text("Battery Optimization is ON", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onErrorContainer)
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "Android may pause payment monitoring after a few minutes in the background. " +
                                "Tap below and choose \"Allow\" / \"Don't optimize\".",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                        )
                        Spacer(Modifier.height(10.dp))
                        Button(
                            onClick = {
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                                    try {
                                        context.startActivity(
                                            Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                                                data = Uri.parse("package:${context.packageName}")
                                            }
                                        )
                                    } catch (_: ActivityNotFoundException) {
                                        // No handler on this ROM — nothing more to do here.
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(Icons.Filled.BatteryAlert, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("Disable Battery Optimization")
                        }
                    }
                }
            } else {
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                    Text(
                        "Battery optimization is already disabled for this app — good.",
                        modifier = Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }
            }

            if (oemAutostartIntent != null) {
                Spacer(Modifier.height(14.dp))
                Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text(
                            "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} devices also have their own " +
                                "separate app manager that can silently stop background monitoring even with " +
                                "battery optimization disabled above.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Spacer(Modifier.height(10.dp))
                        OutlinedButton(
                            onClick = {
                                try {
                                    context.startActivity(oemAutostartIntent)
                                } catch (_: ActivityNotFoundException) {
                                    // Not present on this exact ROM/version — nothing more to do here.
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(Icons.Filled.Settings, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("Allow Auto-start / Remove Restrictions")
                        }
                    }
                }
            }

            Spacer(Modifier.weight(1f))
            Button(
                onClick = {
                    batteryExempt = batteryUnrestricted()
                    onContinue()
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Continue")
            }
            Spacer(Modifier.height(8.dp))
            Text(
                "You can revisit this anytime from More > Permissions.",
                style = MaterialTheme.typography.labelSmall,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
