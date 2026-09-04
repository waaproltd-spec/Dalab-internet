package com.dalab.internet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.ShopAgentOrder
import com.dalab.internet.network.ApiClient
import com.dalab.internet.util.formatApiDateTime
import kotlinx.coroutines.launch

/**
 * Shop order detail for an agent. Complete Order calls the real backend
 * endpoint (POST agent/shop/orders/{id}/complete), which itself refuses
 * anything not currently payment_status=paid and not already terminal
 * (delivered/cancelled/failed/returned/refunded) — canComplete on the model
 * only decides whether the button is usable here, it is not the source of
 * truth; the server's own guard is, so an already-completed order can never
 * be re-actioned even by a stale/cached screen. Mirrors
 * VipAgentOrderDetailScreens.kt's exact current/working/message pattern.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShopAgentOrderDetailScreen(
    order: ShopAgentOrder,
    onBack: () -> Unit,
    onOrderUpdated: (ShopAgentOrder) -> Unit,
) {
    var current by remember(order) { mutableStateOf(order) }
    var working by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun completeOrder() {
        working = true
        message = null
        scope.launch {
            try {
                val response = ApiClient.service.completeAgentShopOrder(current.id)
                response.body()?.let {
                    current = it
                    onOrderUpdated(it)
                    message = "Order marked as delivered."
                } ?: run {
                    message = if (response.code() == 409) {
                        "This order can't be completed — it isn't paid, or it's already been actioned."
                    } else {
                        "Couldn't complete — try again."
                    }
                }
            } catch (_: Exception) {
                message = "Network error while completing."
            }
            working = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Shop Order") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        }
    ) { padding ->
        LazyColumn(modifier = Modifier.padding(padding).padding(horizontal = 20.dp).fillMaxSize()) {
            item {
                Spacer(Modifier.height(20.dp))
                SectionLabel("CUSTOMER")
                DetailRow("Name", current.customerName ?: "Not provided")
                DetailRow("Phone", current.customerPhone ?: "Not provided")

                Spacer(Modifier.height(20.dp))
                SectionLabel("DELIVERY")
                DetailRow("Name", current.deliveryName ?: "Not provided")
                DetailRow("Phone", current.deliveryPhone ?: "Not provided")
                DetailRow("Address", current.deliveryAddress ?: "Not provided")
                if (current.courierName != null) DetailRow("Courier", current.courierName)
                if (current.trackingReference != null) DetailRow("Tracking", current.trackingReference)

                Spacer(Modifier.height(20.dp))
                SectionLabel("ITEMS")
            }
            items(current.items.orEmpty()) { item ->
                Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("${item.quantity ?: 1}× ${item.productName ?: "Item"}", style = MaterialTheme.typography.bodyMedium)
                    Text("$${"%.2f".format(item.subtotal?.toDoubleOrNull() ?: 0.0)}", fontWeight = FontWeight.Medium)
                }
            }
            item {
                Spacer(Modifier.height(20.dp))
                SectionLabel("PAYMENT")
                DetailRow("Method", current.paymentMethod ?: "—")
                if (current.deliveryFee != null) DetailRow("Delivery fee", "$${"%.2f".format(current.deliveryFee.toDoubleOrNull() ?: 0.0)}")
                DetailRow("Total amount", "$${"%.2f".format(current.totalAmount?.toDoubleOrNull() ?: 0.0)}")
                DetailRow("Payment status", current.paymentStatus?.replaceFirstChar { it.uppercase() } ?: "—")

                Spacer(Modifier.height(20.dp))
                SectionLabel("ORDER")
                DetailRow("Status", current.status?.replaceFirstChar { it.uppercase() } ?: "—")
                DetailRow("Date/time", formatApiDateTime(current.createdAt))
                Spacer(Modifier.height(28.dp))

                if (message != null) {
                    Text(message!!, color = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.height(12.dp))
                }

                when {
                    current.isTerminal -> Text(
                        "This order is ${current.status} and can't be changed further.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    !current.isPaid -> Text(
                        "This order hasn't been paid yet — Complete Order unlocks once payment is confirmed.",
                        style = MaterialTheme.typography.labelSmall,
                    )
                    else -> Button(
                        onClick = ::completeOrder,
                        enabled = !working,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(if (working) "Completing..." else "Complete Order")
                    }
                }
                Spacer(Modifier.height(20.dp))
            }
        }
    }
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
