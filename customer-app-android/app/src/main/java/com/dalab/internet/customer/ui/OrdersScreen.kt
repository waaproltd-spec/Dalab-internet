package com.dalab.internet.customer.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.OrderStatus
import com.dalab.internet.customer.data.companyLogoRes
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.RealtimeClient
import com.dalab.internet.customer.util.formatApiDateTime
import kotlinx.coroutines.launch

private val DalabIndigo = Color(0xFF1D2E8C)

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
                LazyColumn(contentPadding = PaddingValues(vertical = 8.dp)) {
                    items(orders, key = { it.id }) { order ->
                        OrderRow(order, onClick = { onOpenOrder(order) })
                    }
                }
            }
        }
    }
}

@Composable
private fun OrderRow(order: CustomerOrder, onClick: () -> Unit) {
    val logoRes = remember(order.companyId) { companyLogoRes(order.companyId) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(CircleShape)
                .background(if (logoRes != null) Color.White else DalabIndigo),
            contentAlignment = Alignment.Center,
        ) {
            if (logoRes != null) {
                Image(
                    painter = painterResource(id = logoRes),
                    contentDescription = order.companyName,
                    modifier = Modifier.size(48.dp).clip(CircleShape),
                )
            } else {
                Text(order.companyName.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold)
            }
        }
        Spacer(Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(order.packageName, fontWeight = FontWeight.Bold, fontSize = 15.sp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(order.companyName, style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                Spacer(Modifier.width(8.dp))
                Icon(Icons.Filled.CalendarToday, contentDescription = null, tint = Color.Gray, modifier = Modifier.size(11.dp))
                Spacer(Modifier.width(4.dp))
                Text(formatApiDateTime(order.createdAt), style = MaterialTheme.typography.bodySmall, color = Color.Gray)
            }
        }
        Spacer(Modifier.width(8.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text("$${"%.2f".format(order.amount)}", fontWeight = FontWeight.Bold, color = DalabIndigo)
            Spacer(Modifier.height(4.dp))
            StatusChip(order.status)
        }
    }
}

private data class StatusStyle(val label: String, val color: Color)

private fun statusStyle(status: OrderStatus): StatusStyle = when (status) {
    OrderStatus.PENDING -> StatusStyle("Awaiting Payment", Color(0xFFB8860B))
    OrderStatus.IN_PROGRESS -> StatusStyle("Payment Confirmed", Color(0xFF1D6FE0))
    OrderStatus.COMPLETED -> StatusStyle("Completed", Color(0xFF16A34A))
    OrderStatus.FAILED -> StatusStyle("Failed", Color(0xFFDC2626))
    OrderStatus.CANCELLED -> StatusStyle("Cancelled", Color(0xFF6B7280))
}

@Composable
fun StatusChip(status: OrderStatus) {
    val style = statusStyle(status)
    Surface(
        color = style.color.copy(alpha = 0.12f),
        shape = RoundedCornerShape(20.dp),
    ) {
        Text(
            style.label,
            color = style.color,
            fontWeight = FontWeight.Bold,
            fontSize = 11.sp,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}
