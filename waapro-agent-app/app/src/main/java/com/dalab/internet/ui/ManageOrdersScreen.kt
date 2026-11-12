package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.Order
import com.dalab.internet.data.OrderStatus
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.launch

/** The filters on Manage Orders, in the order an agent works through them. */
enum class ManageOrdersFilter(val label: String, val status: String?) {
    PENDING("Pending", "pending"),
    PROCESSING("Processing", "in_progress"),
    FAILED("Failed", "failed"),
    COMPLETED("Completed", "completed"),
    CANCELLED("Cancelled", "cancelled"),
}

/** Remembered while the app runs, so coming back from an order keeps the agent's filter. */
private var lastManageOrdersFilter = ManageOrdersFilter.PENDING

/** Long lists (Completed) are cut to the newest orders; search covers what is loaded. */
const val MANAGE_ORDERS_LIMIT = 200

/** Matches an order on its reference, customer/receiver/sender number, customer name or package. */
fun orderMatches(order: Order, query: String): Boolean {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return true
    val digits = q.filter { it.isDigit() }
    val fields = listOfNotNull(order.id, order.customerName, order.packageName, order.companyName)
    if (fields.any { it.lowercase().contains(q) }) return true
    if (digits.length >= 3) {
        val phones = listOfNotNull(order.customerPhone, order.receiverPhone, order.senderPhone)
        if (phones.any { it.filter(Char::isDigit).contains(digits) }) return true
    }
    return false
}

/**
 * Manage Orders: every data order on this system, by status. Tapping one
 * opens its detail screen, where the agent's actions are (approve or reject
 * a payment, cancel, retry, reverse -- see OrderActions.kt). What an agent may
 * do is still decided by the server (operations access, order state).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManageOrdersScreen(onOpenOrder: (Order) -> Unit, onBack: () -> Unit) {
    var filter by remember { mutableStateOf(lastManageOrdersFilter) }
    var search by rememberSaveable { mutableStateOf("") }
    var orders by remember { mutableStateOf<List<Order>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun refresh() {
        loading = true
        val wanted = filter
        scope.launch {
            try {
                val res = ApiClient.service.getOrders(wanted.status)
                if (wanted == filter) {
                    if (res.isSuccessful) {
                        orders = res.body().orEmpty().take(MANAGE_ORDERS_LIMIT)
                        error = null
                    } else {
                        error = "Could not load orders (HTTP ${res.code()})."
                    }
                }
            } catch (_: Exception) {
                if (wanted == filter) error = "Could not reach the server. Check your connection and try again."
            }
            if (wanted == filter) loading = false
        }
    }

    LaunchedEffect(filter) { orders = emptyList(); refresh() }
    LaunchedEffect(Unit) { AgentEventBus.orderEvents.collect { refresh() } }

    val shown = remember(orders, search) { orders.filter { orderMatches(it, search) } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Manage Orders") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    IconButton(onClick = ::refresh) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
                },
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                ManageOrdersFilter.values().forEach { f ->
                    FilterChip(selected = filter == f, onClick = { filter = f; lastManageOrdersFilter = f }, label = { Text(f.label) })
                }
            }
            OutlinedTextField(
                value = search,
                onValueChange = { search = it },
                singleLine = true,
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                placeholder = { Text("Search number, reference or package") },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            )
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            }
            Box(modifier = Modifier.fillMaxSize()) {
                if (loading && orders.isEmpty()) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                } else if (shown.isEmpty()) {
                    Text(
                        if (search.isBlank()) "No ${filter.label.lowercase()} orders." else "No orders match \"$search\".",
                        modifier = Modifier.align(Alignment.Center),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                } else {
                    LazyColumn {
                        items(shown, key = { it.id }) { order ->
                            ManageOrderCard(order = order, onClick = { onOpenOrder(order) })
                            HorizontalDivider()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ManageOrderCard(order: Order, onClick: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp)) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.weight(1f)) {
                Text(order.id, fontWeight = FontWeight.Bold)
                Text("${order.companyName} · ${order.packageName}", style = MaterialTheme.typography.bodySmall)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("$${"%.2f".format(order.amount)}", fontWeight = FontWeight.Bold)
                StatusChip(order)
            }
        }
        val who = order.receiverPhone ?: order.customerPhone
        if (who != null || order.customerName != null) {
            Text(
                listOfNotNull(order.customerName, who).joinToString(" · "),
                style = MaterialTheme.typography.labelSmall,
            )
        }
        Text(order.createdAt.take(16).replace('T', ' '), style = MaterialTheme.typography.labelSmall)
    }
}
