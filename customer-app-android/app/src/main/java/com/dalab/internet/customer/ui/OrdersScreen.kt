package com.dalab.internet.customer.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.OrderStatus
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.RealtimeClient
import kotlinx.coroutines.launch

/** The customer's own order history / tracking — GET /orders. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrdersScreen(onOpenOrder: (CustomerOrder) -> Unit) {
    var orders by remember { mutableStateOf<List<CustomerOrder>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()

    fun refresh() {
        loading = true
        scope.launch {
            try {
                orders = ApiClient.service.getOrders().body().orEmpty()
            } catch (_: Exception) {
                // Leave the previous list in place.
            }
            loading = false
        }
    }

    LaunchedEffect(Unit) { refresh() }

    // Real-time push: any status change on this customer's orders (payment
    // verified, USSD completed) re-fetches the list instead of waiting for a
    // manual pull-to-refresh. No background service in this app (unlike the
    // Agent App) — the connection only lives while this screen is on-screen,
    // which is fine since a customer just watching their orders is exactly
    // when live updates matter most.
    DisposableEffect(Unit) {
        val realtime = RealtimeClient(path = "orders/stream") { refresh() }
        realtime.connect()
        onDispose { realtime.disconnect() }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("My Orders") },
                actions = {
                    IconButton(onClick = { refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            } else if (orders.isEmpty()) {
                Text(
                    "No orders yet — buy your first package from the Home tab.",
                    modifier = Modifier.align(Alignment.Center).padding(24.dp),
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                LazyColumn {
                    items(orders, key = { it.id }) { order ->
                        OrderRow(order, onClick = { onOpenOrder(order) })
                        Divider()
                    }
                }
            }
        }
    }
}

@Composable
private fun OrderRow(order: CustomerOrder, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column {
            Text("${order.companyName} · ${order.packageName}", fontWeight = FontWeight.Bold)
            Text(order.id, style = MaterialTheme.typography.labelSmall)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text("$${"%.2f".format(order.amount)}", fontWeight = FontWeight.Bold)
            StatusChip(order.status)
        }
    }
}

@Composable
fun StatusChip(status: OrderStatus) {
    val label = when (status) {
        OrderStatus.PENDING -> "Awaiting Payment"
        OrderStatus.IN_PROGRESS -> "Payment Confirmed"
        OrderStatus.COMPLETED -> "Completed"
        OrderStatus.FAILED -> "Failed"
        OrderStatus.CANCELLED -> "Cancelled"
    }
    AssistChip(onClick = {}, label = { Text(label) })
}
