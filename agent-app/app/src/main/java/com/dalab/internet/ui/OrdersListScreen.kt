package com.dalab.internet.ui

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
import com.dalab.internet.data.Order
import com.dalab.internet.data.OrderStatus
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrdersListScreen(onOpenOrder: (Order) -> Unit) {
    var orders by remember { mutableStateOf<List<Order>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()

    fun refresh() {
        loading = true
        scope.launch {
            try {
                val response = ApiClient.service.getOrders(status = "pending")
                orders = response.body().orEmpty()
            } catch (_: Exception) {
                // Leave the previous list in place; a banner/snackbar in a full
                // implementation would say "couldn't refresh" here.
            }
            loading = false
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("New Orders") },
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
                    "No pending orders right now.",
                    modifier = Modifier.align(Alignment.Center),
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
private fun OrderRow(order: Order, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(16.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column {
            Text(order.customerName, fontWeight = FontWeight.Bold)
            Text("${order.companyName} · ${order.packageName}", style = MaterialTheme.typography.bodySmall)
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
        OrderStatus.PENDING -> "Pending"
        OrderStatus.IN_PROGRESS -> "In Progress"
        OrderStatus.COMPLETED -> "Completed"
        OrderStatus.FAILED -> "Failed"
        OrderStatus.CANCELLED -> "Cancelled"
    }
    AssistChip(onClick = {}, label = { Text(label) })
}
