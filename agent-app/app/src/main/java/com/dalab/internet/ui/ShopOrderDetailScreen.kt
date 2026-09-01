package com.dalab.internet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.ShopOrder

/**
 * Read-only — reached only by tapping the "💰 Payment Received" push
 * (AgentFcmService.kt's shop_order_detail deep link). By the time this
 * screen is ever shown, paymentStatus is always already "paid" (the push
 * only fires after shopSmsMatching.ts's atomic claim succeeds); status is
 * the independent delivery pipeline, still whatever it was when payment
 * was confirmed (normally "pending" — the Admin Dashboard, not this
 * screen, is where an Admin/Super Admin advances it further).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShopOrderDetailScreen(order: ShopOrder, onBack: () -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Shop Order ${order.id}") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(20.dp)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
        ) {
            SectionLabel("CUSTOMER")
            DetailRow("Name", order.customerName ?: "—")
            DetailRow("Phone", order.customerPhone ?: order.senderPhone ?: "—")

            Spacer(Modifier.height(20.dp))
            SectionLabel("PAYMENT")
            DetailRow("Amount", "$${"%.2f".format(order.totalAmount)}")
            DetailRow("Method", order.paymentMethod ?: "—")
            DetailRow("Payment status", if (order.paymentStatus == "paid") "🟢 Paid" else order.paymentStatus)
            DetailRow("Order status", order.status.replace('_', ' ').replaceFirstChar { it.uppercase() })

            if (order.items.isNotEmpty()) {
                Spacer(Modifier.height(20.dp))
                SectionLabel("ITEMS")
                for (item in order.items) {
                    DetailRow("${item.productName} × ${item.quantity}", "$${"%.2f".format(item.subtotal)}")
                }
            }

            Spacer(Modifier.height(20.dp))
            SectionLabel("DELIVERY")
            DetailRow("Recipient", order.deliveryName ?: "—")
            DetailRow("Phone", order.deliveryPhone ?: "—")
            DetailRow("Address", order.deliveryAddress ?: "—")
            if (!order.trackingReference.isNullOrBlank()) {
                DetailRow("Tracking ref", order.trackingReference)
            }
            if (!order.courierName.isNullOrBlank()) {
                DetailRow("Courier", order.courierName)
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
