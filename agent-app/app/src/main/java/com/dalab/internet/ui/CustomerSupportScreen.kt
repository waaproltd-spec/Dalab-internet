package com.dalab.internet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.SupportTicket
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.launch

/**
 * Customer Support queue — every ticket waiting in the shared "agent" queue,
 * plus whatever this agent has already accepted and is still chatting on.
 * Mirrors ExchangeOrdersListScreen's structure exactly. Reuses the same
 * AgentEventBus.orderEvents signal as every other list here: the backend's
 * support_ticket.updated broadcast goes through the identical shared
 * subscribe/broadcast pub-sub as order events, so no separate SSE
 * connection is needed.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CustomerSupportScreen(onOpenTicket: (SupportTicket) -> Unit, onBack: (() -> Unit)? = null) {
    var tickets by remember { mutableStateOf<List<SupportTicket>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()

    fun refresh() {
        loading = true
        scope.launch {
            try {
                tickets = ApiClient.service.getSupportTickets().body().orEmpty()
            } catch (_: Exception) {
                // Leave the previous list in place.
            }
            loading = false
        }
    }

    LaunchedEffect(Unit) { refresh() }
    LaunchedEffect(Unit) { AgentEventBus.orderEvents.collect { refresh() } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Customer Support") },
                navigationIcon = {
                    // Only shown when this screen is a drill-in (ticket chat's
                    // "back") -- as the top-level Support tab it has no back
                    // target, same as every other bottom-nav tab.
                    if (onBack != null) {
                        IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                    }
                },
                actions = {
                    IconButton(onClick = ::refresh) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
                },
            )
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (loading && tickets.isEmpty()) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            } else if (tickets.isEmpty()) {
                Text(
                    "No customer support requests right now.",
                    modifier = Modifier.align(Alignment.Center),
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(tickets, key = { it.id }) { ticket ->
                        SupportTicketCard(ticket = ticket, onClick = { onOpenTicket(ticket) })
                    }
                }
            }
        }
    }
}

@Composable
private fun SupportTicketCard(ticket: SupportTicket, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Column {
                    Text(ticket.customerName ?: "Customer", fontWeight = FontWeight.Bold)
                    Text(ticket.subject, style = MaterialTheme.typography.bodySmall, maxLines = 2)
                }
                SupportStatusChip(ticket.status)
            }
            Spacer(Modifier.height(8.dp))
            if (ticket.lastMessage != null) {
                Text(ticket.lastMessage, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                Spacer(Modifier.height(4.dp))
            }
            Text(
                "Waiting: ${formatWaitingMinutes(ticket.waitingMinutes)}",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}

private fun formatWaitingMinutes(minutes: Double?): String {
    val m = (minutes ?: 0.0).toInt()
    return if (m < 1) "just now" else "$m min"
}

@Composable
fun SupportStatusChip(status: String) {
    val label = when (status) {
        "waiting" -> "Waiting"
        "in_progress" -> "In Progress"
        "resolved" -> "Resolved"
        else -> status
    }
    AssistChip(onClick = {}, label = { Text(label) })
}
