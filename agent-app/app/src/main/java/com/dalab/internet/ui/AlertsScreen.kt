package com.dalab.internet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.NotificationsNone
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.AgentNotification
import com.dalab.internet.network.ApiClient
import com.dalab.internet.notifications.AgentAlertsState
import com.dalab.internet.util.formatApiDateTime
import kotlinx.coroutines.launch

/**
 * System notices sent from Admin to agents (GET /agent/notifications) — a
 * plain read-only inbox, separate from the "Customer Broadcast" composer in
 * More (which is agents SENDING to customers, not receiving). Opening this
 * screen marks everything currently loaded as seen, clearing the Home badge.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlertsScreen(onBack: () -> Unit) {
    var notifications by remember { mutableStateOf<List<AgentNotification>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun load() {
        loading = true
        error = null
        scope.launch {
            try {
                val response = ApiClient.service.getNotifications()
                if (response.isSuccessful) {
                    notifications = response.body().orEmpty()
                    AgentAlertsState.markAllSeen(notifications)
                } else {
                    error = "Couldn't load notifications."
                }
            } catch (_: Exception) {
                error = "Couldn't load notifications. Check your connection."
            }
            loading = false
        }
    }
    LaunchedEffect(Unit) { load() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Notifications") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    IconButton(onClick = ::load) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
                },
            )
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            when {
                loading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                error != null -> Text(
                    error!!,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.align(Alignment.Center).padding(24.dp),
                    style = MaterialTheme.typography.bodyMedium,
                )
                notifications.isEmpty() -> EmptyAlertsState()
                else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                    items(notifications, key = { it.id }) { notification ->
                        AlertRow(notification)
                        Divider()
                    }
                    item { Spacer(Modifier.height(16.dp)) }
                }
            }
        }
    }
}

@Composable
private fun EmptyAlertsState() {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            Icons.Filled.NotificationsNone,
            contentDescription = null,
            modifier = Modifier.size(48.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))
        Text("No notifications yet", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text(
            "Updates from Admin will show up here.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun AlertRow(notification: AgentNotification) {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)) {
        Surface(
            color = MaterialTheme.colorScheme.primaryContainer,
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.size(40.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.NotificationsNone, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
            }
        }
        Spacer(Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(notification.title, fontWeight = FontWeight.Bold)
            if (notification.body.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(notification.body, style = MaterialTheme.typography.bodyMedium)
            }
            Spacer(Modifier.height(6.dp))
            Text(
                formatApiDateTime(notification.sentAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
