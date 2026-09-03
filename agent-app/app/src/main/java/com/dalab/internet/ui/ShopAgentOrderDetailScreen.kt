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
import com.dalab.internet.util.formatApiDateTime

/**
 * Shop order detail, read-only for an agent — the spec only asks for real
 * visibility into existing Shop order data here, not a new completion
 * action (Shop orders already have their own admin/courier-driven
 * fulfillment lifecycle; nothing in this feature's request touches that).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShopAgentOrderDetailScreen(order: ShopAgentOrder, onBack: () -> Unit) {
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
                DetailRow("Name", order.customerName ?: "Not provided")
                DetailRow("Phone", order.customerPhone ?: "Not provided")

                Spacer(Modifier.height(20.dp))
                SectionLabel("DELIVERY")
                DetailRow("Name", order.deliveryName ?: "Not provided")
                DetailRow("Phone", order.deliveryPhone ?: "Not provided")
                DetailRow("Address", order.deliveryAddress ?: "Not provided")
                if (order.courierName != null) DetailRow("Courier", order.courierName)
                if (order.trackingReference != null) DetailRow("Tracking", order.trackingReference)

                Spacer(Modifier.height(20.dp))
                SectionLabel("ITEMS")
            }
            items(order.items.orEmpty()) { item ->
                Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("${item.quantity ?: 1}× ${item.productName ?: "Item"}", style = MaterialTheme.typography.bodyMedium)
                    Text("$${"%.2f".format(item.subtotal?.toDoubleOrNull() ?: 0.0)}", fontWeight = FontWeight.Medium)
                }
            }
            item {
                Spacer(Modifier.height(20.dp))
                SectionLabel("PAYMENT")
                DetailRow("Method", order.paymentMethod ?: "—")
                if (order.deliveryFee != null) DetailRow("Delivery fee", "$${"%.2f".format(order.deliveryFee.toDoubleOrNull() ?: 0.0)}")
                DetailRow("Total amount", "$${"%.2f".format(order.totalAmount?.toDoubleOrNull() ?: 0.0)}")
                DetailRow("Payment status", order.paymentStatus?.replaceFirstChar { it.uppercase() } ?: "—")

                Spacer(Modifier.height(20.dp))
                SectionLabel("ORDER")
                DetailRow("Status", order.status?.replaceFirstChar { it.uppercase() } ?: "—")
                DetailRow("Date/time", formatApiDateTime(order.createdAt))
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
