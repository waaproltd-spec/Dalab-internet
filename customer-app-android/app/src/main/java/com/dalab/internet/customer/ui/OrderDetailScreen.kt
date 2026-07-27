package com.dalab.internet.customer.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.OrderStatus
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.RealtimeClient
import com.dalab.internet.customer.util.formatApiDateTime
import kotlinx.coroutines.launch

/**
 * Starts from the order object the caller already has (avoids a blank
 * loading flash) but stays live from then on — subscribes to the same SSE
 * stream OrdersScreen uses and re-fetches by id on every event, so a
 * customer watching this screen sees the status flip to "Completed" without
 * navigating back and forth.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrderDetailScreen(initialOrder: CustomerOrder, onBack: () -> Unit) {
    var order by remember { mutableStateOf(initialOrder) }
    val scope = rememberCoroutineScope()

    fun refresh() {
        scope.launch {
            try {
                ApiClient.service.getOrder(initialOrder.id).body()?.let { order = it }
            } catch (_: Exception) {
                // Leave the previous state in place — the next SSE event retries.
            }
        }
    }

    DisposableEffect(Unit) {
        val realtime = RealtimeClient(path = "orders/stream") { refresh() }
        realtime.connect()
        onDispose { realtime.disconnect() }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Order ${order.id}") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).padding(20.dp).fillMaxSize()) {
            SectionLabel("SERVICE DETAILS")
            DetailRow("Provider", order.companyName)
            DetailRow("Package", order.packageName)
            DetailRow("Amount", "$${"%.2f".format(order.amount)}")
            DetailRow("Payment Method", order.paymentMethod ?: "—")
            DetailRow("Order Date", formatApiDateTime(order.createdAt))

            Spacer(Modifier.height(20.dp))
            SectionLabel("STATUS")
            StatusChip(order.status)
            Spacer(Modifier.height(8.dp))
            Text(statusMessage(order.status), style = MaterialTheme.typography.bodyMedium)

            if (order.status == OrderStatus.COMPLETED) {
                Spacer(Modifier.height(20.dp))
                SectionLabel("MACAASH REWARDS")
                DetailRow("Points earned", "+${order.macaashEarned}")
                if (order.completedAt != null) {
                    DetailRow("Completed", formatApiDateTime(order.completedAt))
                }
            }
        }
    }
}

private fun statusMessage(status: OrderStatus): String = when (status) {
    OrderStatus.PENDING -> "Waiting for payment confirmation."
    OrderStatus.IN_PROGRESS -> "Payment confirmed — your order is being processed."
    OrderStatus.COMPLETED -> "Your package has been activated."
    OrderStatus.FAILED -> "This order failed. Please try again or contact support."
    OrderStatus.CANCELLED -> "This order was cancelled."
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
    Spacer(Modifier.height(6.dp))
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(value, fontWeight = FontWeight.Medium)
    }
}
