package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.diagnostics.DiagnosticsLog
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Read-only view of DiagnosticsLog -- what the automatic pipeline (SMS
 * upload and recovery, verify-payment, dial logging, queue drains, SIM
 * routing) recorded on this device. Errors in red, notes in blue.
 */
@Composable
fun DiagnosticsScreen(onBack: () -> Unit) {
    var entries by remember { mutableStateOf(DiagnosticsLog.all()) }
    var filter by remember { mutableStateOf(0) } // 0 all, 1 errors, 2 notes
    var confirmClear by remember { mutableStateOf(false) }
    val errors = entries.count { it.isError }
    val shown = when (filter) { 1 -> entries.filter { it.isError }; 2 -> entries.filter { !it.isError }; else -> entries }

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
                    Text("Diagnostics", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp, modifier = Modifier.weight(1f))
                    if (entries.isNotEmpty()) {
                        IconButton(onClick = { confirmClear = true }) { Icon(Icons.Filled.Delete, contentDescription = "Clear", tint = Color.White) }
                    }
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(horizontal = 8.dp)) {
                    DiagFilter("All", entries.size, selected = filter == 0, alert = false, modifier = Modifier.weight(1f)) { filter = 0 }
                    DiagFilter("Errors", errors, selected = filter == 1, alert = errors > 0, modifier = Modifier.weight(1f)) { filter = 1 }
                    DiagFilter("Notes", entries.size - errors, selected = filter == 2, alert = false, modifier = Modifier.weight(1f)) { filter = 2 }
                }
            }
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (shown.isEmpty()) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.fillMaxWidth().padding(top = 56.dp, start = 32.dp, end = 32.dp),
                ) {
                    Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = StatusGreen, modifier = Modifier.size(56.dp))
                    Spacer(Modifier.height(12.dp))
                    Text(when (filter) { 1 -> "No errors"; 2 -> "No notes"; else -> "Nothing recorded" }, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                }
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    // Keyed by position: two entries can share timestamp and tag
                    // (a retry storm), and content keys crashed this list before.
                    itemsIndexed(shown, key = { index, _ -> index }) { _, entry -> DiagEntryCard(entry) }
                }
            }
        }
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("Clear diagnostics?") },
            confirmButton = {
                TextButton(onClick = {
                    DiagnosticsLog.clear()
                    entries = DiagnosticsLog.all()
                    confirmClear = false
                }) { Text("Clear", color = StatusRed, fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Keep") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DiagFilter(label: String, count: Int, selected: Boolean, alert: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = when { selected -> WaaproGold; alert -> StatusRed.copy(alpha = 0.85f); else -> Color.White.copy(alpha = 0.14f) },
        onClick = onClick,
        modifier = modifier,
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            val ink = if (selected) WaaproNavy else Color.White
            Text("$count", color = ink, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp)
            Text(label, color = ink.copy(alpha = 0.85f), fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** "sms_recovery_completed" -> "Sms recovery completed". */
private fun readableTag(tag: String): String =
    tag.replace('_', ' ').trim().replaceFirstChar { it.uppercase() }

private fun ago(ts: Long): String {
    val s = (System.currentTimeMillis() - ts) / 1000
    return when {
        s < 60 -> "just now"
        s < 3600 -> "${s / 60} min ago"
        s < 86400 -> "${s / 3600} h ago"
        else -> "${s / 86400} d ago"
    }
}

@Composable
private fun DiagEntryCard(entry: DiagnosticsLog.Entry) {
    val ink = if (entry.isError) StatusRed else WaaproBlue
    Surface(
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 1.dp,
        modifier = Modifier.fillMaxWidth().border(1.dp, if (entry.isError) StatusRed.copy(alpha = 0.35f) else WaaproBorder, RoundedCornerShape(18.dp)),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.size(36.dp).clip(CircleShape).background(ink.copy(alpha = 0.12f)), contentAlignment = Alignment.Center) {
                Icon(if (entry.isError) Icons.Filled.ErrorOutline else Icons.Filled.Info, contentDescription = null, tint = ink, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(readableTag(entry.tag), fontWeight = FontWeight.ExtraBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Spacer(Modifier.width(8.dp))
                    Text(ago(entry.timestamp), color = WaaproMuted, fontSize = 11.5.sp)
                }
                Spacer(Modifier.height(4.dp))
                Text(entry.message, color = if (entry.isError) StatusRed else WaaproMuted, fontSize = 13.sp, maxLines = 4, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(6.dp))
                Text(SimpleDateFormat("d MMM, HH:mm:ss", Locale.US).format(Date(entry.timestamp)), color = WaaproMuted, fontSize = 11.sp)
            }
        }
    }
}
