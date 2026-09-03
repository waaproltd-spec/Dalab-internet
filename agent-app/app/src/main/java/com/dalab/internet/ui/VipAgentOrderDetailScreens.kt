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
import com.dalab.internet.data.VipNumberAgentOrder
import com.dalab.internet.data.VipPackageAgentOrder
import com.dalab.internet.network.ApiClient
import com.dalab.internet.util.formatApiDateTime
import kotlinx.coroutines.launch

/**
 * VIP Number and VIP Number Package order detail — the one place an agent
 * can actually complete a real, paid VIP order. Both screens share the
 * exact list-detail-POST pattern OrderDetailScreen.kt already established
 * (current/working/message state triad, POST-then-refresh-current-from-
 * response, onOrderUpdated pushes the fresh object back up to MainActivity's
 * lifted state) — kept in one file since the two orders are structurally
 * the same thing (one or several VIP numbers + one total price) and a
 * second copy of that pattern would just be noise.
 *
 * Complete Order calls the real backend endpoints
 * (POST agent/vip-numbers/orders/{id}/complete,
 * POST agent/vip-numbers/packages/orders/{id}/complete) which themselves
 * refuse anything not currently paid_status=paid and not already terminal
 * — canComplete here only decides whether the button is usable, it is not
 * the source of truth; the server's own guard is.
 */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VipNumberAgentOrderDetailScreen(
    order: VipNumberAgentOrder,
    onBack: () -> Unit,
    onOrderUpdated: (VipNumberAgentOrder) -> Unit,
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
                val response = ApiClient.service.completeAgentVipNumberOrder(current.id)
                response.body()?.let {
                    current = it
                    onOrderUpdated(it)
                    message = "Order marked as completed."
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
                title = { Text("VIP Number Order") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).padding(20.dp).fillMaxSize()) {
            SectionLabel("VIP NUMBER")
            DetailRow("Number", current.phoneNumber ?: "—")
            DetailRow("Company", current.companyName ?: "—")
            DetailRow("Category", current.category?.replaceFirstChar { it.uppercase() } ?: "—")

            Spacer(Modifier.height(20.dp))
            SectionLabel("CUSTOMER")
            DetailRow("Full name", current.customerFullName ?: current.customerName ?: "Not provided")
            DetailRow("Phone", current.customerPhone ?: "Not provided")
            DetailRow("Location/City", current.location ?: "Not provided")
            DetailRow("District", current.district ?: "Not provided")
            DetailRow("Mother's name", current.motherName ?: "Not provided")

            Spacer(Modifier.height(20.dp))
            SectionLabel("PAYMENT")
            DetailRow("Method", current.paymentMethod ?: "—")
            DetailRow("Amount paid", "$${"%.2f".format(current.price?.toDoubleOrNull() ?: 0.0)}")
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
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VipPackageAgentOrderDetailScreen(
    order: VipPackageAgentOrder,
    onBack: () -> Unit,
    onOrderUpdated: (VipPackageAgentOrder) -> Unit,
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
                val response = ApiClient.service.completeAgentVipPackageOrder(current.id)
                response.body()?.let {
                    current = it
                    onOrderUpdated(it)
                    message = "Order marked as completed."
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
                title = { Text("VIP Package Order") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        }
    ) { padding ->
        LazyColumn(modifier = Modifier.padding(padding).padding(horizontal = 20.dp).fillMaxSize()) {
            item {
                Spacer(Modifier.height(20.dp))
                SectionLabel("${current.size ?: current.items?.size ?: "?"} NUMBERS PACKAGE")
            }
            items(current.items.orEmpty()) { item ->
                Column(modifier = Modifier.padding(vertical = 6.dp)) {
                    Text(item.phoneNumber ?: "—", fontWeight = FontWeight.Medium)
                    Text(
                        listOfNotNull(item.companyName, item.category?.replaceFirstChar { it.uppercase() }).joinToString(" · "),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
            item {
                Spacer(Modifier.height(20.dp))
                SectionLabel("CUSTOMER")
                DetailRow("Full name", current.customerFullName ?: current.customerName ?: "Not provided")
                DetailRow("Phone", current.customerPhone ?: "Not provided")
                DetailRow("Location/City", current.location ?: "Not provided")
                DetailRow("District", current.district ?: "Not provided")
                DetailRow("Mother's name", current.motherName ?: "Not provided")

                Spacer(Modifier.height(20.dp))
                SectionLabel("PAYMENT")
                DetailRow("Method", current.paymentMethod ?: "—")
                DetailRow("Total package price", "$${"%.2f".format(current.price?.toDoubleOrNull() ?: 0.0)}")
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
