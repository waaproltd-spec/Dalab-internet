package com.dalab.internet.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.ExchangeOrder
import com.dalab.internet.data.ExchangeOrderStatus
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.launch

/**
 * Money Exchange's own queue screen — mirrors OrdersListScreen's structure
 * but scoped to what the agent-facing GET /agent/exchange/orders endpoint
 * returns: verified (in_progress) exchanges waiting to be paid out. A
 * completed/failed history view lives in the admin dashboard for v1 — see
 * the Money Exchange plan's explicit scope decision.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExchangeOrdersListScreen(onOpenOrder: (ExchangeOrder) -> Unit, onOpenSetup: () -> Unit, onBack: () -> Unit) {
    var orders by remember { mutableStateOf<List<ExchangeOrder>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()

    fun refresh() {
        loading = true
        scope.launch {
            try {
                orders = ApiClient.service.getExchangeOrders().body().orEmpty()
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
                title = { Text("Money Exchange") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    IconButton(onClick = ::refresh) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
                    IconButton(onClick = onOpenSetup) { Icon(Icons.Filled.Settings, contentDescription = "Money Exchange Setup") }
                },
            )
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (loading && orders.isEmpty()) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            } else if (orders.isEmpty()) {
                Text(
                    "No exchanges waiting for payout right now.",
                    modifier = Modifier.align(Alignment.Center),
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                LazyColumn {
                    items(orders, key = { it.id }) { order ->
                        ExchangeOrderCard(order = order, onClick = { onOpenOrder(order) })
                        Divider()
                    }
                }
            }
        }
    }
}

@Composable
private fun ExchangeOrderCard(order: ExchangeOrder, onClick: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp)) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Column {
                Text(order.id, fontWeight = FontWeight.Bold)
                Text(
                    "${order.fromWalletName ?: order.fromWalletId} → ${order.toWalletName ?: order.toWalletId}",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("$${"%.2f".format(order.amountReceived)}", fontWeight = FontWeight.Bold)
                ExchangeStatusChip(order.status)
            }
        }
        Spacer(Modifier.height(8.dp))
        ExchangeDetailLine("Sent", "$${"%.2f".format(order.amountSent)}")
        ExchangeDetailLine("Receiver", order.receiverPhone)
        ExchangeDetailLine("Sender", order.senderPhone)
    }
}

@Composable
private fun ExchangeDetailLine(label: String, value: String) {
    Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelSmall)
        Text(value, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium)
    }
}

@Composable
fun ExchangeStatusChip(status: ExchangeOrderStatus) {
    val label = when (status) {
        ExchangeOrderStatus.PENDING -> "Pending"
        ExchangeOrderStatus.IN_PROGRESS -> "Awaiting Payout"
        ExchangeOrderStatus.COMPLETED -> "Completed"
        ExchangeOrderStatus.FAILED -> "Failed"
        ExchangeOrderStatus.CANCELLED -> "Cancelled"
    }
    AssistChip(onClick = {}, label = { Text(label) })
}
