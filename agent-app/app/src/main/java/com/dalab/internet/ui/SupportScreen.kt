package com.dalab.internet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.SupportConversation
import com.dalab.internet.data.SupportConversationStatus
import com.dalab.internet.data.SupportMessage
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.SupportSendMessageRequest
import com.dalab.internet.network.SupportStatusUpdateRequest
import com.dalab.internet.support.SupportQueueState
import com.dalab.internet.util.formatApiDateTime
import kotlinx.coroutines.launch

/**
 * The Agent App's counterpart to the Admin Dashboard's "Agent Support" panel
 * (super-admin-app/src/App.jsx) — same backend routes (dual-registered at
 * /admin/support/... and /agent/support/... by support.routes.ts), same
 * queue, same conversations. Online/offline toggle, the live waiting list
 * with a claim-next shortcut, and — once a conversation is assigned to this
 * agent — the chat itself with Resolve/Close. Real time comes from the same
 * SSE stream (agent/orders/stream, via AgentEventBus.orderEvents) every
 * other screen in this app already reuses; the backend broadcasts
 * support_conversation.updated on it exactly like it does order.updated, so
 * this screen just re-fetches on any event rather than trusting a payload.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SupportScreen(onBack: () -> Unit) {
    var online by remember { mutableStateOf(false) }
    var activeConversationId by remember { mutableStateOf<String?>(null) }
    var queue by remember { mutableStateOf<List<SupportConversation>>(emptyList()) }
    var conversation by remember { mutableStateOf<SupportConversation?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var claimingId by remember { mutableStateOf<String?>(null) }
    var togglingOnline by remember { mutableStateOf(false) }
    var messageText by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var ending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
        try {
            val status = ApiClient.service.getSupportStatus().body()
            online = status?.online ?: false
            activeConversationId = status?.activeConversationId

            val currentId = activeConversationId
            if (currentId != null) {
                conversation = ApiClient.service.getSupportConversation(currentId).body()
            } else {
                conversation = null
                val fetchedQueue = ApiClient.service.getSupportQueue().body().orEmpty()
                queue = fetchedQueue
                SupportQueueState.update(fetchedQueue)
            }
            error = null
        } catch (e: Exception) {
            error = "Couldn't refresh: ${e.message ?: "network error"}"
        }
        loading = false
    }

    LaunchedEffect(Unit) { refresh() }
    // Backend broadcasts support_conversation.updated on this exact same
    // stream AgentBackgroundService keeps connected for order events -- no
    // separate connection needed, just re-fetch on any signal.
    LaunchedEffect(Unit) { AgentEventBus.orderEvents.collect { refresh() } }

    fun toggleOnline(next: Boolean) {
        togglingOnline = true
        scope.launch {
            try {
                ApiClient.service.setSupportStatus(SupportStatusUpdateRequest(next))
                // Going offline mid-conversation reassigns it back to the pool
                // server-side (support.routes.ts's PUT /support/status) --
                // this refresh is what picks that up and clears the chat view.
                refresh()
            } catch (e: Exception) {
                error = "Couldn't update status: ${e.message ?: "network error"}"
            }
            togglingOnline = false
        }
    }

    fun claimNext() {
        claimingId = "__next__"
        scope.launch {
            try {
                val result = ApiClient.service.claimNextSupportConversation().body()
                if (result?.claimed == null) {
                    error = "No customers waiting right now."
                }
                refresh()
            } catch (e: Exception) {
                error = "Couldn't claim: ${e.message ?: "network error"}"
            }
            claimingId = null
        }
    }

    fun claimSpecific(id: String) {
        claimingId = id
        scope.launch {
            try {
                ApiClient.service.claimSupportConversation(id)
                refresh()
            } catch (e: Exception) {
                error = "Couldn't claim: ${e.message ?: "network error"}"
            }
            claimingId = null
        }
    }

    fun sendMessage() {
        val id = activeConversationId ?: return
        val text = messageText.trim()
        if (text.isEmpty()) return
        sending = true
        scope.launch {
            try {
                val updated = ApiClient.service.sendSupportMessage(id, SupportSendMessageRequest(text)).body()
                if (updated != null) conversation = updated
                messageText = ""
            } catch (e: Exception) {
                error = "Couldn't send: ${e.message ?: "network error"}"
            }
            sending = false
        }
    }

    fun endConversation(resolve: Boolean) {
        val id = activeConversationId ?: return
        ending = true
        scope.launch {
            try {
                if (resolve) ApiClient.service.resolveSupportConversation(id) else ApiClient.service.closeSupportConversation(id)
                // The backend auto-claims the next waiting customer for this
                // same agent right after ending this one (FIFO) -- refresh()
                // picks that up the same way it does everything else.
                refresh()
            } catch (e: Exception) {
                error = "Couldn't end conversation: ${e.message ?: "network error"}"
            }
            ending = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Agent Support") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(end = 12.dp)) {
                        Text(if (online) "Online" else "Offline", style = MaterialTheme.typography.labelMedium)
                        Spacer(Modifier.width(8.dp))
                        Switch(checked = online, onCheckedChange = { toggleOnline(it) }, enabled = !togglingOnline)
                    }
                },
            )
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            when {
                loading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                conversation != null -> SupportConversationView(
                    conversation = conversation!!,
                    messageText = messageText,
                    onMessageChange = { messageText = it },
                    onSend = { sendMessage() },
                    sending = sending,
                    onResolve = { endConversation(true) },
                    onClose = { endConversation(false) },
                    ending = ending,
                    error = error,
                )
                else -> SupportQueueView(
                    online = online,
                    queue = queue,
                    claimingId = claimingId,
                    error = error,
                    onClaimNext = { claimNext() },
                    onClaimSpecific = { claimSpecific(it) },
                )
            }
        }
    }
}

@Composable
private fun SupportQueueView(
    online: Boolean,
    queue: List<SupportConversation>,
    claimingId: String?,
    error: String?,
    onClaimNext: () -> Unit,
    onClaimSpecific: (String) -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Surface(color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(20.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        "${queue.size}",
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        if (queue.size == 1) "customer waiting" else "customers waiting",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                Button(onClick = onClaimNext, enabled = online && queue.isNotEmpty() && claimingId == null) {
                    Text(if (claimingId == "__next__") "Claiming…" else "Claim Next")
                }
            }
        }

        if (!online) {
            Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                Text(
                    "Go online to claim a waiting customer.",
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }
        error?.let {
            Text(
                it,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                style = MaterialTheme.typography.labelMedium,
            )
        }

        if (queue.isEmpty()) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                Text(
                    "No customers waiting right now.",
                    modifier = Modifier.align(Alignment.Center),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        } else {
            LazyColumn(modifier = Modifier.weight(1f).fillMaxWidth()) {
                items(queue, key = { it.id }) { item ->
                    QueueConversationCard(
                        item = item,
                        claiming = claimingId == item.id,
                        enabled = online && claimingId == null,
                        onClaim = { onClaimSpecific(item.id) },
                    )
                    Divider()
                }
            }
        }
    }
}

@Composable
private fun QueueConversationCard(
    item: SupportConversation,
    claiming: Boolean,
    enabled: Boolean,
    onClaim: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.weight(1f)) {
                Text(item.customerName ?: item.customerPhone ?: "Customer", fontWeight = FontWeight.Bold)
                Text(item.customerPhone ?: "", style = MaterialTheme.typography.bodySmall)
            }
            AssistChip(
                onClick = {},
                label = { Text(if (item.status == SupportConversationStatus.QUEUED) "Waiting" else "Left a message") },
            )
        }
        item.firstMessage?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(formatApiDateTime(item.createdAt), style = MaterialTheme.typography.labelSmall)
            OutlinedButton(onClick = onClaim, enabled = enabled) {
                Text(if (claiming) "Claiming…" else "Claim")
            }
        }
    }
}

@Composable
private fun SupportConversationView(
    conversation: SupportConversation,
    messageText: String,
    onMessageChange: (String) -> Unit,
    onSend: () -> Unit,
    sending: Boolean,
    onResolve: () -> Unit,
    onClose: () -> Unit,
    ending: Boolean,
    error: String?,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                Text(conversation.customerName ?: conversation.customerPhone ?: "Customer", fontWeight = FontWeight.Bold)
                Text(conversation.customerPhone ?: "", style = MaterialTheme.typography.bodySmall)
            }
        }
        error?.let {
            Text(
                it,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                style = MaterialTheme.typography.labelMedium,
            )
        }

        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
            reverseLayout = true,
        ) {
            items(conversation.messages.reversed(), key = { it.id }) { message ->
                MessageBubble(message)
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedButton(onClick = onResolve, enabled = !ending, modifier = Modifier.weight(1f)) {
                Icon(Icons.Filled.CheckCircle, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Resolve")
            }
            OutlinedButton(onClick = onClose, enabled = !ending, modifier = Modifier.weight(1f)) {
                Icon(Icons.Filled.Close, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Close")
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = messageText,
                onValueChange = onMessageChange,
                modifier = Modifier.weight(1f),
                placeholder = { Text("Type a reply…") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                maxLines = 4,
            )
            IconButton(onClick = onSend, enabled = !sending && messageText.isNotBlank()) {
                Icon(Icons.Filled.Send, contentDescription = "Send")
            }
        }
    }
}

@Composable
private fun MessageBubble(message: SupportMessage) {
    val isAgent = message.senderType == "agent"
    val isSystem = message.senderType == "system"
    val alignment = if (isAgent) Alignment.CenterEnd else Alignment.CenterStart
    val bubbleColor = when {
        isSystem -> MaterialTheme.colorScheme.surfaceVariant
        isAgent -> MaterialTheme.colorScheme.primaryContainer
        else -> MaterialTheme.colorScheme.secondaryContainer
    }

    Box(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), contentAlignment = alignment) {
        Surface(
            color = bubbleColor,
            shape = RoundedCornerShape(14.dp),
        ) {
            Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
                Text(message.body, style = MaterialTheme.typography.bodyMedium)
                message.createdAt?.let {
                    Text(formatApiDateTime(it), style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}
