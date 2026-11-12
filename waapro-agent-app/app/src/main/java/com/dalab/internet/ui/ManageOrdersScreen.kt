package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
        containerColor = WaaproBg,
        topBar = {
            TopAppBar(
                title = { Text("Manage Orders", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    IconButton(onClick = ::refresh) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = WaaproNavy,
                    titleContentColor = Color.White,
                    navigationIconContentColor = Color.White,
                    actionIconContentColor = Color.White,
                ),
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                ManageOrdersFilter.values().forEach { f ->
                    val selected = filter == f
                    Surface(
                        onClick = { filter = f; lastManageOrdersFilter = f },
                        shape = RoundedCornerShape(14.dp),
                        color = if (selected) WaaproBlue else Color.White,
                        border = if (selected) null else BorderStroke(1.dp, WaaproBorder),
                        shadowElevation = if (selected) 2.dp else 0.dp,
                    ) {
                        Text(
                            f.label,
                            color = if (selected) Color.White else WaaproNavy,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
                        )
                    }
                }
            }
            OutlinedTextField(
                value = search,
                onValueChange = { search = it },
                singleLine = true,
                shape = RoundedCornerShape(14.dp),
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null, tint = WaaproNavy) },
                placeholder = { Text("Search number, reference or package", color = WaaproMuted) },
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = Color.White,
                    unfocusedContainerColor = Color.White,
                    focusedBorderColor = WaaproBlue,
                    unfocusedBorderColor = WaaproBorder,
                    focusedTextColor = WaaproInk,
                    unfocusedTextColor = WaaproInk,
                ),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            )
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            }
            Box(modifier = Modifier.fillMaxSize()) {
                if (loading && orders.isEmpty()) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center), color = WaaproBlue)
                } else if (shown.isEmpty()) {
                    Text(
                        if (search.isBlank()) "No ${filter.label.lowercase()} orders." else "No orders match \"$search\".",
                        modifier = Modifier.align(Alignment.Center),
                        color = WaaproMuted,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                } else {
                    LazyColumn(
                        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(shown, key = { it.id }) { order ->
                            ManageOrderCard(order = order, onClick = { onOpenOrder(order) })
                        }
                    }
                }
            }
        }
    }
}

/** Pill colours per status: (background, text). */
private fun statusColors(order: Order): Pair<Color, Color> = when (order.status) {
    OrderStatus.PENDING -> WaaproSoft to WaaproNavy
    OrderStatus.IN_PROGRESS -> Color(0xFFFFF3D6) to Color(0xFF8A5A00)
    OrderStatus.FAILED -> Color(0xFFFDE2E2) to Color(0xFFB42318)
    OrderStatus.COMPLETED -> Color(0xFFDDF5E5) to Color(0xFF117A3D)
    OrderStatus.CANCELLED -> Color(0xFFECEEF2) to WaaproMuted
}

private fun statusLabel(order: Order): String = when (order.status) {
    OrderStatus.PENDING -> "Pending"
    OrderStatus.IN_PROGRESS -> if (order.ussdGenerated != null) "Delivering" else "Processing"
    OrderStatus.FAILED -> "Failed"
    OrderStatus.COMPLETED -> "Completed"
    OrderStatus.CANCELLED -> "Cancelled"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ManageOrderCard(order: Order, onClick: () -> Unit) {
    val (pillBg, pillText) = statusColors(order)
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(16.dp),
        color = Color.White,
        border = BorderStroke(1.dp, WaaproBorder),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(modifier = Modifier.padding(start = 16.dp, end = 8.dp, top = 14.dp, bottom = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(order.id, color = WaaproNavy, fontWeight = FontWeight.ExtraBold, style = MaterialTheme.typography.titleMedium)
                Text(
                    "${order.companyName} · ${order.packageName}",
                    color = WaaproInk,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(6.dp))
                val who = order.receiverPhone ?: order.customerPhone
                if (who != null || order.customerName != null) {
                    CardLine(Icons.Filled.Phone, listOfNotNull(order.customerName, who).joinToString(" · "))
                }
                CardLine(Icons.Filled.Schedule, order.createdAt.take(16).replace('T', ' '))
            }
            Spacer(Modifier.width(8.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text("$${"%.2f".format(order.amount)}", color = WaaproNavy, fontWeight = FontWeight.ExtraBold, style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(6.dp))
                Surface(shape = RoundedCornerShape(50), color = pillBg) {
                    Text(
                        statusLabel(order),
                        color = pillText,
                        fontWeight = FontWeight.SemiBold,
                        style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                    )
                }
            }
            Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = WaaproNavy, modifier = Modifier.padding(start = 4.dp))
        }
    }
}

@Composable
private fun CardLine(icon: ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
        Icon(icon, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text(text, color = WaaproMuted, style = MaterialTheme.typography.bodySmall)
    }
}
