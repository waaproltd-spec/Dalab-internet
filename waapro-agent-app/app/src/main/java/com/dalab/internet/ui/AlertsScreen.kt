package com.dalab.internet.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.material.icons.filled.Campaign
import com.dalab.internet.ui.i18n.Text
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
                    // One row per notification id: a repeated id (e.g. from a
                    // retried or overlapping load) is never shown twice, while
                    // two notices with the same text but different ids both are.
                    notifications = response.body().orEmpty().distinctBy { it.id }
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
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(WaaproHeaderBrush, RoundedCornerShape(bottomStart = 26.dp, bottomEnd = 26.dp))
                    .padding(start = 8.dp, end = 8.dp, top = 10.dp, bottom = 16.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                    Text("Notifications", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp, modifier = Modifier.weight(1f))
                    IconButton(onClick = ::load) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = Color.White) }
                }
                if (notifications.isNotEmpty()) {
                    Text(
                        "${notifications.size} message${if (notifications.size == 1) "" else "s"} from Admin",
                        color = Color.White.copy(alpha = 0.85f), fontSize = 13.sp, modifier = Modifier.padding(start = 16.dp),
                    )
                }
            }
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
                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(notifications, key = { it.id }) { notification ->
                        AlertRow(notification)
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
    }
}

@Composable
private fun AlertRow(notification: AgentNotification) {
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 2.dp,
        modifier = Modifier.fillMaxWidth().border(1.dp, WaaproBorder.copy(alpha = 0.5f), RoundedCornerShape(20.dp)),
    ) {
        Row(modifier = Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.size(42.dp).clip(CircleShape).background(WaaproHeaderBrush), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Campaign, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(notification.title, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.width(8.dp))
                    Text(formatApiDateTime(notification.sentAt), color = WaaproMuted, fontSize = 11.sp, maxLines = 1)
                }
                if (notification.body.isNotBlank()) {
                    Spacer(Modifier.height(4.dp))
                    Text(notification.body, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.85f))
                }
            }
        }
    }
}
