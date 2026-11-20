package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.PowerManager
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.filled.BatteryChargingFull
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
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
    val heartbeatFailuresByCategory = remember(tick) {
        HeartbeatStats.failureCountsByCategory().entries.sortedByDescending { it.value }
    }

    val sleepProtection = when {
        serviceRunning && batteryExempt -> "Fully protected" to 0
        serviceRunning || batteryExempt -> "Partially protected" to 1
        else -> "At risk" to 2
    }

    Scaffold(
        topBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(WaaproHeaderBrush, RoundedCornerShape(bottomStart = 26.dp, bottomEnd = 26.dp))
                    .padding(start = 8.dp, end = 16.dp, top = 10.dp, bottom = 18.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                    Text("Reliability", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp)
                }
                Spacer(Modifier.height(10.dp))
                Box(Modifier.padding(start = 8.dp)) {
                    StatusBanner(sleepProtection.first, ok = sleepProtection.second == 0, warn = sleepProtection.second == 1)
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
                { m -> StatusTile(Icons.Filled.Sync, "Background service", serviceRunning, "Running", "Not running", m) },
                { m -> StatusTile(Icons.Filled.Sms, "SMS reader", smsListening, "Active", "Inactive", m) },
                { m -> StatusTile(Icons.Filled.Wifi, "Internet", networkOnline, "Online", "Offline", m) },
                { m -> StatusTile(Icons.Filled.BatteryChargingFull, "Battery", batteryExempt, "Unrestricted", "Restricted", m) },
            ))

            Spacer(Modifier.height(18.dp))
            StatusSection("Heartbeat") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(10.dp).clip(CircleShape).background(if (lastHeartbeatAt != null) StatusGreen else StatusRed))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        if (lastHeartbeatAt != null) "Last: ${relativeAge(lastHeartbeatAt)}" else "No heartbeat yet",
                        fontWeight = FontWeight.Bold, fontSize = 15.sp,
                    )
                    Spacer(Modifier.weight(1f))
                    Text(formatTimestamp(lastHeartbeatAt), color = WaaproMuted, fontSize = 12.sp)
                }
                Spacer(Modifier.height(14.dp))
                Row {
                    StatusFigure("$heartbeatSuccess", "Successful", Modifier.weight(1f), StatusGreen)
                    StatusFigure("$heartbeatFailure", "Failed", Modifier.weight(1f), if (heartbeatFailure > 0) StatusRed else Color.Unspecified)
                    val total = heartbeatSuccess + heartbeatFailure
                    StatusFigure(if (total > 0) "${heartbeatSuccess * 100 / total}%" else "-", "Success rate", Modifier.weight(1f))
                }
                if (heartbeatFailuresByCategory.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) {
                        heartbeatFailuresByCategory.forEach { (category, count) -> StatePill("$category · $count", WaaproMuted) }
                    }
                }
                if (lastHeartbeatError != null) {
                    Spacer(Modifier.height(10.dp))
                    Text("Last error: $lastHeartbeatError", fontSize = 12.sp, color = StatusRed, maxLines = 2)
                }
            }

            Spacer(Modifier.height(18.dp))
            StatusSection("Offline queue") {
                if (pendingActions.isEmpty()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = StatusGreen, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Nothing waiting", fontWeight = FontWeight.Bold)
                    }
                } else {
                    Row {
                        StatusFigure("${pendingActions.size}", "Waiting", Modifier.weight(1f), StatusAmber)
                        val oldest = pendingActions.minByOrNull { it.createdAt }
                        StatusFigure(relativeAge(oldest?.createdAt).ifEmpty { "-" }, "Oldest", Modifier.weight(1f))
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) {
                        pendingActions.groupBy { it.type }.forEach { (type, items) ->
                            StatePill("${type.name.replace("_", " ").lowercase().replaceFirstChar { it.uppercase() }} · ${items.size}", StatusAmber)
                        }
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
