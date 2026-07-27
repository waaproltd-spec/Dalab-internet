package com.dalab.internet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.diagnostics.DiagnosticsLog
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Read-only view of DiagnosticsLog — recent failures across the automatic
 * pipeline (SMS upload, verify-payment, dial-attempt logging, queue drains,
 * SIM routing refresh) that happened on this device, previously only
 * visible in Logcat.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiagnosticsScreen(onBack: () -> Unit) {
    var entries by remember { mutableStateOf(DiagnosticsLog.all()) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Diagnostics") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = {
                        DiagnosticsLog.clear()
                        entries = DiagnosticsLog.all()
                    }) {
                        Icon(Icons.Filled.Delete, contentDescription = "Clear")
                    }
                },
            )
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (entries.isEmpty()) {
                Text(
                    "No errors or retries recorded — everything's been running cleanly.",
                    modifier = Modifier.align(Alignment.Center).padding(24.dp),
                )
            } else {
                LazyColumn {
                    items(entries, key = { "${it.timestamp}-${it.tag}" }) { entry ->
                        Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
                            Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                                Text(entry.tag, fontWeight = FontWeight.Bold)
                                Text(
                                    SimpleDateFormat("MMM d, HH:mm:ss", Locale.US).format(Date(entry.timestamp)),
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            }
                            Spacer(Modifier.height(4.dp))
                            Text(
                                entry.message,
                                style = MaterialTheme.typography.bodySmall,
                                color = if (entry.isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Divider()
                    }
                }
            }
        }
    }
}
