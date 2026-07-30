package com.dalab.internet.ui

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.PowerManager
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.diagnostics.HeartbeatStats
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.service.AgentBackgroundService
import com.dalab.internet.sms.SmsListenerState
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

private fun isNetworkOnline(context: Context): Boolean {
    val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
    val network = cm.activeNetwork ?: return false
    val capabilities = cm.getNetworkCapabilities(network) ?: return false
    return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
}

private fun formatTimestamp(millis: Long?): String {
    if (millis == null) return "Never"
    return DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM).format(Date(millis))
}

private fun relativeAge(millis: Long?): String {
    if (millis == null) return ""
    val seconds = (System.currentTimeMillis() - millis) / 1000
    return when {
        seconds < 60 -> "${seconds}s ago"
        seconds < 3600 -> "${seconds / 60}m ago"
        else -> "${seconds / 3600}h ago"
    }
}

/**
 * Live, on-device view of everything that keeps automatic payment
 * processing running 24/7 — the foreground service, the heartbeat loop,
 * SMS reading, connectivity, battery-optimization exemption, and the
 * offline queue — in one screen instead of scattered across Permissions/
 * Diagnostics. Every signal here is read directly from the same objects
 * that drive the real pipeline (AgentBackgroundService.isRunning,
 * HeartbeatStats, SmsListenerState, PendingActionQueue) — there is no
 * separate "dashboard-only" state that could fall out of sync with reality.
 * Polls every ~3s since none of these sources are StateFlows themselves.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReliabilityDashboardScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    var tick by remember { mutableStateOf(0) }

    LaunchedEffect(Unit) {
        while (true) {
            tick++
            delay(3000)
        }
    }

    val serviceRunning = AgentBackgroundService.isRunning
    val smsListening by SmsListenerState.isListening.collectAsState()
    val networkOnline = remember(tick) { isNetworkOnline(context) }
    val batteryExempt = remember(tick) {
        val pm = context.getSystemService(PowerManager::class.java)
        pm?.isIgnoringBatteryOptimizations(context.packageName) ?: true
    }
    val pendingActions = remember(tick) { PendingActionQueue.all() }
    val heartbeatSuccess = remember(tick) { HeartbeatStats.successCount() }
    val heartbeatFailure = remember(tick) { HeartbeatStats.failureCount() }
    val lastHeartbeatAt = remember(tick) { HeartbeatStats.lastSuccessAt() }
    val lastHeartbeatError = remember(tick) { HeartbeatStats.lastError() }

    // Not a new low-level Android capability — a plain-language combination
    // of the two things that actually keep this process alive through Doze/
    // App Standby (the foreground service itself, and the battery-optimization
    // exemption), so an agent doesn't have to mentally combine the two rows
    // above themselves to know whether they're actually covered.
    val sleepProtection = when {
        serviceRunning && batteryExempt -> Triple(
            "Fully Protected", Color(0xFF16A34A),
            "Foreground service active and battery optimization disabled — Android should not stop this app during sleep.",
        )
        serviceRunning || batteryExempt -> Triple(
            "Partially Protected", Color(0xFFB8860B),
            "Only one of the two protections is active — the app may still be paused during deep sleep.",
        )
        else -> Triple(
            "At Risk", Color(0xFFDC2626),
            "Neither protection is active — Android is likely to stop background processing.",
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Reliability Dashboard") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } },
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(20.dp)
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
        ) {
            Text(
                "Live status of everything that keeps payment processing running around the clock on this device.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(16.dp))

            ReliabilityRow(
                "Foreground Service", serviceRunning, "Running", "Not running",
                "Keeps the SSE connection, heartbeat, and SMS pipeline alive in the background.",
            )
            Spacer(Modifier.height(10.dp))
            ReliabilityRow(
                "SMS Reader", smsListening, "Active", "Inactive",
                "Detects incoming payment confirmation SMS the instant it arrives.",
            )
            Spacer(Modifier.height(10.dp))
            ReliabilityRow(
                "Internet Connection", networkOnline, "Online", "Offline",
                "Required for heartbeats, SMS uploads, and order processing.",
            )
            Spacer(Modifier.height(10.dp))
            ReliabilityRow(
                "Battery Optimization", batteryExempt, "Disabled (exempt)", "Enabled (restricted)",
                "Android may pause this app in the background if optimization is still enabled.",
            )
            Spacer(Modifier.height(14.dp))

            Surface(color = sleepProtection.second.copy(alpha = 0.1f), shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Warning, contentDescription = null, tint = sleepProtection.second, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Device Sleep Protection: ${sleepProtection.first}", fontWeight = FontWeight.Bold, color = sleepProtection.second)
                    }
                    Spacer(Modifier.height(4.dp))
                    Text(sleepProtection.third, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            Spacer(Modifier.height(18.dp))
            Text("Heartbeat", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(8.dp))
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    StatLine(
                        "Last successful heartbeat",
                        if (lastHeartbeatAt != null) "${formatTimestamp(lastHeartbeatAt)} (${relativeAge(lastHeartbeatAt)})" else "Never",
                    )
                    StatLine("Successful", "$heartbeatSuccess")
                    StatLine("Failed", "$heartbeatFailure")
                    if (lastHeartbeatError != null) {
                        Spacer(Modifier.height(6.dp))
                        Text("Last error: $lastHeartbeatError", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    }
                }
            }

            Spacer(Modifier.height(18.dp))
            Text("Offline Queue", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(8.dp))
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    if (pendingActions.isEmpty()) {
                        Text("Nothing queued — all work has been sent to the server.", style = MaterialTheme.typography.bodySmall)
                    } else {
                        StatLine("Pending items", "${pendingActions.size}")
                        pendingActions.groupBy { it.type }.forEach { (type, items) ->
                            StatLine(type.name.replace("_", " ").lowercase().replaceFirstChar { it.uppercase() }, "${items.size}")
                        }
                        val oldest = pendingActions.minByOrNull { it.createdAt }
                        if (oldest != null) {
                            Spacer(Modifier.height(6.dp))
                            Text(
                                "Oldest queued: ${relativeAge(oldest.createdAt)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun ReliabilityRow(label: String, ok: Boolean, okLabel: String, notOkLabel: String, description: String) {
    val color = if (ok) Color(0xFF16A34A) else Color(0xFFDC2626)
    Surface(color = color.copy(alpha = 0.08f), shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
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
                Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(if (ok) okLabel else notOkLabel, color = color, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun StatLine(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontWeight = FontWeight.Medium)
    }
}
