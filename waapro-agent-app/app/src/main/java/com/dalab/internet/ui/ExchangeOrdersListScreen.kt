package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.CurrencyExchange
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.data.ExchangeOrder
import com.dalab.internet.data.ExchangeOrderStatus
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.launch

/**
 * Money Exchange's own queue screen: what GET /agent/exchange/orders
 * returns -- verified (in_progress) exchanges waiting to be paid out. A
 * completed/failed history view lives in the admin dashboard.
 */
@Composable
fun ExchangeOrdersListScreen(onOpenOrder: (ExchangeOrder) -> Unit, onOpenSetup: () -> Unit, onBack: () -> Unit) {
    var orders by remember { mutableStateOf<List<ExchangeOrder>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()

    fun refresh() {
        loading = true
        scope.launch {
            try {
                orders = ApiClient.service.getExchangeOrders().body().orEmpty()
            } catch (_: Exception) {
                // Leave the previous list in place.
            }
            loading = false
        }
    }

    LaunchedEffect(Unit) { refresh() }
    LaunchedEffect(Unit) { AgentEventBus.orderEvents.collect { refresh() } }

    Scaffold(
        topBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(WaaproHeaderBrush, RoundedCornerShape(bottomStart = 26.dp, bottomEnd = 26.dp))
                    .padding(start = 8.dp, end = 8.dp, top = 10.dp, bottom = 18.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                    Text("Money Exchange", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp, modifier = Modifier.weight(1f))
                    IconButton(onClick = ::refresh) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = Color.White) }
                    IconButton(onClick = onOpenSetup) { Icon(Icons.Filled.Settings, contentDescription = "Money Exchange Setup", tint = Color.White) }
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(horizontal = 8.dp)) {
                    ExchangePill("Waiting", orders.size.toString(), Modifier.weight(1f))
                    ExchangePill("To pay out", money(orders.sumOf { it.amountReceived }), Modifier.weight(1f))
                    ExchangePill("Received", money(orders.sumOf { it.amountSent }), Modifier.weight(1f))
                }
            }
        },
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            when {
                loading && orders.isEmpty() -> CircularProgressIndicator(color = WaaproNavy, modifier = Modifier.align(Alignment.Center))
                orders.isEmpty() -> Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.fillMaxWidth().padding(top = 48.dp, start = 32.dp, end = 32.dp),
                ) {
                    BrandIconTile(Icons.Filled.CurrencyExchange, size = 64.dp)
                    Spacer(Modifier.height(14.dp))
                    Text("Nothing waiting for payout", fontWeight = FontWeight.Bold, fontSize = 17.sp)
                }
                else -> LazyColumn(
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(orders, key = { it.id }) { order -> ExchangeOrderCard(order = order, onClick = { onOpenOrder(order) }) }
                }
            }
        }
    }
}

private fun money(n: Double): String = "$" + "%.2f".format(n)
private fun local9(p: String?): String = p?.filter { it.isDigit() }?.takeLast(9)?.ifEmpty { null } ?: "-"

@Composable
private fun ExchangePill(label: String, value: String, modifier: Modifier) {
    Surface(shape = RoundedCornerShape(16.dp), color = Color.White.copy(alpha = 0.14f), modifier = modifier) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(value, color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 18.sp, maxLines = 1)
            Text(label, color = Color.White.copy(alpha = 0.85f), fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun ExchangeLine(icon: ImageVector, label: String, value: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(28.dp).clip(CircleShape).background(WaaproNavy.copy(alpha = 0.10f)), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(16.dp))
        }
        Spacer(Modifier.width(10.dp))
        Text(label, color = WaaproMuted, fontSize = 13.sp, modifier = Modifier.width(78.dp))
        Text(value, fontWeight = FontWeight.Bold, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** One exchange: wallets, amount to pay out, received / receiver / sender / time, its state. */
@Composable
private fun ExchangeOrderCard(order: ExchangeOrder, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 2.dp,
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, WaaproBorder, RoundedCornerShape(20.dp))
            .clip(RoundedCornerShape(20.dp))
            .clickable(onClick = onClick),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(44.dp).clip(CircleShape).background(WaaproNavy.copy(alpha = 0.10f)), contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.CurrencyExchange, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(22.dp))
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(order.fromWalletName ?: order.fromWalletId, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, maxLines = 1)
                        Icon(Icons.Filled.ArrowForward, contentDescription = null, tint = WaaproMuted, modifier = Modifier.padding(horizontal = 6.dp).size(16.dp))
                        Text(order.toWalletName ?: order.toWalletId, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    order.customerName?.takeIf { it.isNotBlank() }?.let {
                        Text(it, color = WaaproMuted, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                Spacer(Modifier.width(8.dp))
                Column(horizontalAlignment = Alignment.End) {
                    Text(money(order.amountReceived), fontWeight = FontWeight.ExtraBold, color = Color(0xFF137A3A), fontSize = 18.sp)
                    Text("to pay", color = WaaproMuted, fontSize = 11.sp)
                }
            }
            Spacer(Modifier.height(12.dp))
            ExchangeLine(Icons.Filled.Payments, "Received", money(order.amountSent))
            Spacer(Modifier.height(6.dp))
            ExchangeLine(Icons.Filled.ArrowForward, "Pay to", local9(order.receiverPhone))
            Spacer(Modifier.height(6.dp))
            ExchangeLine(Icons.Filled.Person, "Sender", local9(order.senderPhone))
            Spacer(Modifier.height(6.dp))
            ExchangeLine(Icons.Filled.Schedule, "Time", scheduleTimeText(order.createdAt))
            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = WaaproBorder)
            Row(verticalAlignment = Alignment.CenterVertically) {
                ExchangeStatusChip(order.status)
                Spacer(Modifier.weight(1f))
                Text(order.id, color = WaaproMuted, fontSize = 11.sp, maxLines = 1)
            }
        }
    }
}

/** The exchange's state as a coloured pill (also used on the detail screen). */
@Composable
fun ExchangeStatusChip(status: ExchangeOrderStatus) {
    val (label, ink, bg) = when (status) {
        ExchangeOrderStatus.PENDING -> Triple("Pending", Color(0xFF8A6200), Color(0xFFFFF4D6))
        ExchangeOrderStatus.IN_PROGRESS -> Triple("Awaiting Payout", Color(0xFF1D4ED8), Color(0xFFDBEAFE))
        ExchangeOrderStatus.COMPLETED -> Triple("Completed", Color(0xFF137A3A), Color(0xFFE6F6EC))
        ExchangeOrderStatus.FAILED -> Triple("Failed", Color(0xFFDC2626), Color(0xFFFDE2E2))
        ExchangeOrderStatus.CANCELLED -> Triple("Cancelled", Color(0xFF5B6475), Color(0xFFE5E7EB))
    }
    Surface(shape = RoundedCornerShape(50), color = bg) {
        Text(label, color = ink, fontWeight = FontWeight.Bold, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
    }
}
