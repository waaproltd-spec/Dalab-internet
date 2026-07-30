package com.dalab.internet.customer.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
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
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.OrderStatus
import com.dalab.internet.customer.data.companyLogoRes
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.ConnectionState
import com.dalab.internet.customer.network.RealtimeClient
import com.dalab.internet.customer.prefs.LocalizationManager
import com.dalab.internet.customer.util.formatApiDateTime
import kotlinx.coroutines.launch

private val HeaderStart = Color(0xFF1D2E8C)
private val HeaderEnd = Color(0xFF16A34A)

/** The customer's own order history / tracking — GET /orders. */
@Composable
fun OrdersScreen(onOpenOrder: (CustomerOrder) -> Unit) {
    var orders by remember { mutableStateOf<List<CustomerOrder>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var contentVisible by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val compact = LocalConfiguration.current.screenHeightDp < 700
    var connectionState by remember { mutableStateOf(ConnectionState.CONNECTING) }

    fun refresh() {
        loading = true
        scope.launch {
            try {
                orders = ApiClient.service.getOrders().body().orEmpty()
            } catch (_: Exception) {
                // Leave the previous list in place.
            }
            loading = false
            contentVisible = true
        }
    }

    LaunchedEffect(Unit) { refresh() }

    // Real-time push: any status change on this customer's orders (payment
    // verified, USSD completed) re-fetches the list instead of waiting for a
    // manual pull-to-refresh. No background service in this app (unlike the
    // Agent App) — the connection only lives while this screen is on-screen,
    // which is fine since a customer just watching their orders is exactly
    // when live updates matter most.
    val realtime = remember { RealtimeClient(path = "orders/stream") { refresh() } }
    DisposableEffect(realtime) {
        realtime.connect()
        onDispose { realtime.disconnect() }
    }
    LaunchedEffect(realtime) {
        realtime.state.collect { connectionState = it }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        Brush.linearGradient(listOf(HeaderStart, HeaderEnd)),
                        shape = RoundedCornerShape(bottomStart = 24.dp, bottomEnd = 24.dp),
                    )
                    .padding(horizontal = 20.dp, vertical = if (compact) 14.dp else 20.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column {
                        Text(
                            LocalizationManager.tr("My Orders", "Dalabyadayda"),
                            color = Color.White,
                            fontWeight = FontWeight.Bold,
                            fontSize = 19.sp,
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            val (dotColor, label) = when (connectionState) {
                                ConnectionState.CONNECTED -> Color(0xFF6FE39A) to LocalizationManager.tr("Live", "Toos ah")
                                ConnectionState.CONNECTING -> Color(0xFFF2C200) to LocalizationManager.tr("Reconnecting…", "Isku xidhaya…")
                                ConnectionState.DISCONNECTED -> Color(0xFFF87171) to LocalizationManager.tr("Disconnected", "Go'ay")
                            }
                            Icon(Icons.Filled.Circle, contentDescription = null, tint = dotColor, modifier = Modifier.size(7.dp))
                            Spacer(Modifier.width(5.dp))
                            Text(label, color = Color.White.copy(alpha = 0.85f), fontSize = 11.sp)
                        }
                    }
                    IconButton(onClick = { refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = Color.White)
                    }
                }
            }
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            } else if (orders.isEmpty()) {
                Text(
                    LocalizationManager.tr(
                        "No orders yet — buy your first package from the Home tab.",
                        "Wali dalab kuma lihid — ka iibso baakadaadii ugu horreysay tabka Guriga.",
                    ),
                    modifier = Modifier.align(Alignment.Center).padding(24.dp),
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                AnimatedVisibility(
                    visible = contentVisible,
                    enter = fadeIn(tween(350)) + slideInVertically(tween(350)) { it / 10 },
                ) {
                    LazyColumn(
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(orders, key = { it.id }) { order ->
                            OrderRow(order, onClick = { onOpenOrder(order) })
                        }
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
            .shadow(2.dp, RoundedCornerShape(18.dp))
            .clip(RoundedCornerShape(18.dp))
            .background(MaterialTheme.colorScheme.surface)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(CircleShape)
                .background(if (logoRes != null) MaterialTheme.colorScheme.surface else HeaderStart),
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
            Text(order.packageName, fontWeight = FontWeight.Bold, fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(order.companyName, style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                Spacer(Modifier.width(8.dp))
                Icon(Icons.Filled.CalendarToday, contentDescription = null, tint = Color.Gray, modifier = Modifier.size(11.dp))
                Spacer(Modifier.width(4.dp))
                Text(formatApiDateTime(order.createdAt), style = MaterialTheme.typography.bodySmall, color = Color.Gray)
            }
            if (order.scheduledAt != null) {
                Spacer(Modifier.height(4.dp))
                Surface(
                    color = Color(0xFF7C3AED).copy(alpha = 0.12f),
                    shape = RoundedCornerShape(20.dp),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                    ) {
                        Icon(Icons.Filled.Schedule, contentDescription = null, tint = Color(0xFF7C3AED), modifier = Modifier.size(11.dp))
                        Spacer(Modifier.width(4.dp))
                        Text(
                            LocalizationManager.tr("Scheduled: ", "La qorsheeyay: ") + formatApiDateTime(order.scheduledAt),
                            color = Color(0xFF7C3AED),
                            fontWeight = FontWeight.Bold,
                            fontSize = 10.sp,
                        )
                    }
                }
            }
        }
        Spacer(Modifier.width(8.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text("$${"%.2f".format(order.amount)}", fontWeight = FontWeight.Bold, color = HeaderStart)
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
