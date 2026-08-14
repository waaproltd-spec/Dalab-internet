package com.dalab.internet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.SupportMessage
import com.dalab.internet.data.SupportMessageRequest
import com.dalab.internet.data.SupportTicket
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.launch

/**
 * A single support ticket: Accept (while waiting), then a live chat with
 * the customer once accepted, then Resolve. The customer's AI conversation
 * (if any) and the required Somali handoff message already arrive as
 * ordinary messages in the same list — nothing special to render for those.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SupportTicketChatScreen(initialTicket: SupportTicket, onBack: () -> Unit) {
    var ticket by remember { mutableStateOf(initialTicket) }
    var input by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var accepting by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()

    fun refresh() {
        scope.launch {
            try {
                ApiClient.service.getSupportTicket(ticket.id).body()?.let { ticket = it }
            } catch (_: Exception) {
                // Keep showing the last known state.
            }
        }
    }

    // initialTicket comes from the queue list, which only carries a
    // lastMessage preview (not the full conversation) — load the real
    // detail as soon as the screen opens, not just on the next event.
    LaunchedEffect(Unit) { refresh() }
    LaunchedEffect(Unit) { AgentEventBus.orderEvents.collect { refresh() } }
    LaunchedEffect(ticket.messages?.size) {
        val count = ticket.messages?.size ?: 0
        if (count > 0) listState.animateScrollToItem(count - 1)
    }

    fun accept() {
        accepting = true
        scope.launch {
            try {
                ApiClient.service.acceptSupportTicket(ticket.id).body()?.let { ticket = it }
            } catch (_: Exception) {
                // The queue list will show this ticket again if someone else got it first.
            }
            accepting = false
        }
    }

    fun send() {
        val body = input.trim()
        if (body.isEmpty() || sending) return
        sending = true
        input = ""
        scope.launch {
            try {
                ApiClient.service.sendSupportMessage(ticket.id, SupportMessageRequest(body)).body()?.let { ticket = it }
            } catch (_: Exception) {
                input = body // put it back so the agent doesn't lose what they typed
            }
            sending = false
        }
    }

    fun resolve() {
        scope.launch {
            try {
                ApiClient.service.resolveSupportTicket(ticket.id).body()?.let { ticket = it }
            } catch (_: Exception) {
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(ticket.customerName ?: "Customer Support") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    if (ticket.status == "in_progress") {
                        IconButton(onClick = ::resolve) { Icon(Icons.Filled.Check, contentDescription = "Mark Resolved") }
                    }
                },
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                if (ticket.status == "waiting") {
                    Column(
                        modifier = Modifier.align(Alignment.Center).padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(ticket.subject, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(16.dp))
                        Button(onClick = ::accept, enabled = !accepting) {
                            Text(if (accepting) "Accepting..." else "Accept")
                        }
                    }
                } else {
                    LazyColumn(state = listState, modifier = Modifier.fillMaxSize().padding(12.dp)) {
                        items(ticket.messages.orEmpty(), key = { it.id }) { m -> SupportMessageBubble(m) }
                    }
                }
            }
            if (ticket.status == "in_progress") {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("Type a message...") },
                        maxLines = 4,
                    )
                    Spacer(Modifier.width(8.dp))
                    IconButton(onClick = ::send, enabled = !sending) {
                        Icon(Icons.Filled.Send, contentDescription = "Send")
                    }
                }
            }
            if (ticket.status == "resolved") {
                Text(
                    "Resolved",
                    modifier = Modifier.fillMaxWidth().padding(16.dp),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

@Composable
private fun SupportMessageBubble(message: SupportMessage) {
    if (message.senderType == "system") {
        Text(
            message.body,
            modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            style = MaterialTheme.typography.labelSmall,
            fontStyle = FontStyle.Italic,
        )
        return
    }
    val fromMe = message.senderType == "agent"
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        horizontalArrangement = if (fromMe) Arrangement.End else Arrangement.Start,
    ) {
        Surface(
            color = if (fromMe) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
            shape = MaterialTheme.shapes.medium,
        ) {
            Text(
                message.body,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                color = if (fromMe) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
