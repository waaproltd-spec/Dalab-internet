package com.dalab.internet.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SettingsInputAntenna
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.data.Order
import com.dalab.internet.data.OrderStatus
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.ConnectionState
import com.dalab.internet.service.AgentBackgroundService
import com.dalab.internet.ussd.SimRoutingRepository
import com.dalab.internet.ussd.SimSlotResult
import com.dalab.internet.ussd.UssdOrchestrator
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// DALAB brand — Dark Azure + Soft Blue, shared with the Customer App and
// Admin Dashboard. DalabGreen stays separate: it's the functional
// success/money-earned color (line below and the sale-amount text further
// down), not brand, per the shared two-color rule's own carve-out.
private val DalabIndigo = Color(0xFF003152)
private val DalabSoftBlue = Color(0xFFADDFF1)
private val DalabGreen = Color(0xFF16A34A)

private enum class OrdersFilter(val label: String, val apiStatus: String?) {
    PENDING("Pending", "pending"),
    COMPLETED("Completed", "completed"),
    ALL("All", null),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrdersListScreen(onOpenOrder: (Order) -> Unit) {
    val context = LocalContext.current
    var orders by remember { mutableStateOf<List<Order>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var lastSyncedAt by remember { mutableStateOf<Date?>(null) }
    var filter by remember { mutableStateOf(OrdersFilter.PENDING) }
    var selectedIds by remember { mutableStateOf(setOf<String>()) }
    var executingId by remember { mutableStateOf<String?>(null) }
    var bulkExecuting by remember { mutableStateOf(false) }
    var resultMessage by remember { mutableStateOf<String?>(null) }
    val connectionState by AgentEventBus.connectionState.collectAsState()
    val scope = rememberCoroutineScope()
    val orchestrator = remember { UssdOrchestrator(context) }

    var todaySales by remember { mutableStateOf(0.0) }
    var todayOrders by remember { mutableStateOf(0) }
    // Independent of the filter chips below (Pending/Completed/All) — always
    // the most recent orders across every status, so this card gives a true
    // "what just happened" feed regardless of which filter the agent has
    // selected for the main list.
    var recentActivity by remember { mutableStateOf<List<Order>>(emptyList()) }

    fun smsListeningActive(): Boolean {
        val readGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED
        val receiveGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        return readGranted && receiveGranted && AgentBackgroundService.isRunning
    }
    var listeningActive by remember { mutableStateOf(smsListeningActive()) }

    fun refreshDashboard() {
        listeningActive = smsListeningActive()
        scope.launch {
            try {
                val report = ApiClient.service.getReports("daily").body()
                todaySales = report?.series?.sumOf { it.sales } ?: 0.0
                todayOrders = report?.series?.sumOf { it.orders } ?: 0
            } catch (_: Exception) {
                // Dashboard tiles just keep their last known value on failure.
            }
            try {
                recentActivity = ApiClient.service.getOrders(status = null).body().orEmpty().take(5)
            } catch (_: Exception) {
                // Leave the previous list in place.
            }
        }
    }
    LaunchedEffect(Unit) { refreshDashboard() }
    LaunchedEffect(Unit) { AgentEventBus.orderEvents.collect { refreshDashboard() } }

    fun refresh() {
        loading = true
        scope.launch {
            try {
                val response = ApiClient.service.getOrders(status = filter.apiStatus)
                orders = response.body().orEmpty()
                lastSyncedAt = Date()
            } catch (_: Exception) {
                // Leave the previous list in place; a banner/snackbar in a full
                // implementation would say "couldn't refresh" here.
            }
            loading = false
        }
    }

    LaunchedEffect(filter) {
        selectedIds = emptySet()
        refresh()
    }

    // Real-time push: AgentBackgroundService owns the single SSE connection
    // (so it keeps running even off this screen / in the background) and
    // broadcasts here on every order change anywhere (customer app, another
    // agent, the dashboard) instead of this screen opening its own connection.
    LaunchedEffect(Unit) {
        AgentEventBus.orderEvents.collect { refresh() }
    }

    val pendingIds = orders.filter { it.status == OrderStatus.PENDING }.map { it.id }.toSet()

    fun executeOne(order: Order, simSlot: Int) {
        executingId = order.id
        scope.launch {
            val result = orchestrator.executeManually(order.id, simSlot)
            resultMessage = "${order.id}: ${result.outcome} — ${result.responseMessage ?: ""}".trim()
            executingId = null
            refresh()
        }
    }

    fun executeSelectedBulk() {
        val targets = orders.filter { selectedIds.contains(it.id) && it.status == OrderStatus.PENDING }
        if (targets.isEmpty()) return
        bulkExecuting = true
        scope.launch {
            var successCount = 0
            for (order in targets) {
                val slot = (SimRoutingRepository.simSlotFor(order.companyId) as? SimSlotResult.Slot)?.slot ?: 1
                val result = orchestrator.executeManually(order.id, slot)
                if (result.outcome.name == "SUCCESS") successCount++
            }
            resultMessage = "Bulk fulfillment: $successCount of ${targets.size} succeeded."
            selectedIds = emptySet()
            bulkExecuting = false
            refresh()
        }
    }

    Scaffold { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            AgentHomeHeader(
                agentName = remember { SessionManager.currentAgent()?.name },
                listeningActive = listeningActive,
                connectionState = connectionState,
                lastSyncedAt = lastSyncedAt,
                todaySales = todaySales,
                todayOrders = todayOrders,
                onRefresh = { refresh(); refreshDashboard() },
            )

            RecentActivityCard(orders = recentActivity)

            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OrdersFilter.entries.forEach { f ->
                    FilterChip(selected = filter == f, onClick = { filter = f }, label = { Text(f.label) })
                }
            }

            if (filter == OrdersFilter.PENDING && pendingIds.isNotEmpty()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    TextButton(onClick = {
                        selectedIds = if (selectedIds.containsAll(pendingIds)) emptySet() else pendingIds
                    }) {
                        Text(if (selectedIds.containsAll(pendingIds)) "Deselect All Pending" else "Select All Pending")
                    }
                    if (selectedIds.isNotEmpty()) {
                        Button(onClick = { executeSelectedBulk() }, enabled = !bulkExecuting) {
                            Text(if (bulkExecuting) "Executing…" else "Fulfill ${selectedIds.size} Selected")
                        }
                    }
                }
            }

            resultMessage?.let {
                Text(it, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp), style = MaterialTheme.typography.labelMedium)
            }

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                if (loading) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                } else if (orders.isEmpty()) {
                    Text(
                        "No ${filter.label.lowercase()} orders right now.",
                        modifier = Modifier.align(Alignment.Center),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                } else {
                    LazyColumn {
                        items(orders, key = { it.id }) { order ->
                            OrderCard(
                                order = order,
                                selectable = filter == OrdersFilter.PENDING,
                                selected = selectedIds.contains(order.id),
                                onToggleSelected = {
                                    selectedIds = if (selectedIds.contains(order.id)) selectedIds - order.id else selectedIds + order.id
                                },
                                onClick = { onOpenOrder(order) },
                                onExecute = { simSlot -> executeOne(order, simSlot) },
                                executing = executingId == order.id,
                            )
                            Divider()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AgentHomeHeader(
    agentName: String?,
    listeningActive: Boolean,
    connectionState: ConnectionState,
    lastSyncedAt: Date?,
    todaySales: Double,
    todayOrders: Int,
    onRefresh: () -> Unit,
) {
    val infiniteTransition = rememberInfiniteTransition(label = "listening-pulse")
    val pulseScale by infiniteTransition.animateFloat(
        initialValue = 0.85f,
        targetValue = 1.15f,
        animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Reverse),
        label = "listening-pulse-scale",
    )

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                Brush.linearGradient(listOf(DalabIndigo, DalabSoftBlue)),
                shape = RoundedCornerShape(bottomStart = 24.dp, bottomEnd = 24.dp),
            )
            .padding(20.dp),
    ) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Column {
                Text("DALAB AGENT", color = Color.White, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                Text(
                    agentName?.let { "Welcome back, $it" } ?: "Welcome back",
                    color = Color.White.copy(alpha = 0.85f),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            IconButton(onClick = onRefresh) {
                Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = Color.White)
            }
        }

        Spacer(Modifier.height(16.dp))

        Surface(color = Color.White.copy(alpha = 0.15f), shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
            Row(modifier = Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .scale(if (listeningActive) pulseScale else 1f)
                        .background(Color.White.copy(alpha = if (listeningActive) 0.25f else 0.12f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.SettingsInputAntenna, contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
                }
                Spacer(Modifier.width(12.dp))
                Column {
                    Text(
                        if (listeningActive) "SMS Listening — Active" else "SMS Listening — Inactive",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        if (listeningActive) "Background service is monitoring payment SMS" else "Grant SMS permissions in More → Permissions",
                        color = Color.White.copy(alpha = 0.8f),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
        }

        Spacer(Modifier.height(10.dp))

        Row(verticalAlignment = Alignment.CenterVertically) {
            val (dotColor, label) = when (connectionState) {
                ConnectionState.CONNECTED -> Color(0xFF6FE39A) to "Connected"
                ConnectionState.CONNECTING -> Color(0xFFF2C200) to "Reconnecting…"
                ConnectionState.DISCONNECTED -> Color(0xFFF87171) to "Disconnected"
            }
            Icon(Icons.Filled.Circle, contentDescription = null, tint = dotColor, modifier = Modifier.size(7.dp))
            Spacer(Modifier.width(5.dp))
            Text(label, color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.labelSmall)
            lastSyncedAt?.let {
                Text(
                    "  ·  Synced ${SimpleDateFormat("HH:mm:ss", Locale.US).format(it)}",
                    color = Color.White.copy(alpha = 0.7f),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }

        Spacer(Modifier.height(16.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
            HomeStatCard(label = "Today's Sales", value = "$${"%.2f".format(todaySales)}", modifier = Modifier.weight(1f))
            HomeStatCard(label = "Today's Orders", value = todayOrders.toString(), modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun HomeStatCard(label: String, value: String, modifier: Modifier = Modifier) {
    Surface(color = Color.White, shape = RoundedCornerShape(14.dp), modifier = modifier) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(value, color = DalabIndigo, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleLarge)
            Text(label, color = Color.Gray, style = MaterialTheme.typography.labelSmall)
        }
    }
}

// A separate, self-contained card — deliberately not merged into the
// filterable orders list below it, which stays scoped to actionable
// (mostly-pending) work. This one is a quick-glance feed of what just
// happened across every status, sender-agnostic of the filter chips.
@Composable
private fun RecentActivityCard(orders: List<Order>) {
    if (orders.isEmpty()) return

    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        shape = RoundedCornerShape(16.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                "Recent Activity",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color = DalabIndigo,
            )
            Spacer(Modifier.height(10.dp))
            orders.forEachIndexed { index, order ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(order.customerName ?: "Customer", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                        Text(order.companyName, style = MaterialTheme.typography.labelSmall, color = Color.Gray)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text("$${"%.2f".format(order.amount)}", fontWeight = FontWeight.Bold, color = DalabGreen)
                        Spacer(Modifier.height(4.dp))
                        StatusChip(order)
                    }
                }
                if (index != orders.lastIndex) Divider(modifier = Modifier.padding(top = 2.dp))
            }
        }
    }
}

@Composable
private fun OrderCard(
    order: Order,
    selectable: Boolean,
    selected: Boolean,
    onToggleSelected: () -> Unit,
    onClick: () -> Unit,
    onExecute: (Int) -> Unit,
    executing: Boolean,
) {
    val recommendedSlot = remember(order.companyId) { SimRoutingRepository.cachedSlotFor(order.companyId) }

    Column(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp)) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (selectable) {
                    Checkbox(checked = selected, onCheckedChange = { onToggleSelected() })
                }
                Column {
                    Text(order.id, fontWeight = FontWeight.Bold)
                    Text("${order.companyName} · ${order.packageName}", style = MaterialTheme.typography.bodySmall)
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("$${"%.2f".format(order.amount)}", fontWeight = FontWeight.Bold)
                StatusChip(order)
            }
        }

        Spacer(Modifier.height(8.dp))
        DetailLine("Receiver", order.receiverPhone ?: "—")
        DetailLine("Sender wallet number", order.senderPhone ?: "—")
        DetailLine("Payment wallet", order.paymentMethod ?: "—")

        if (order.status == OrderStatus.PENDING) {
            Spacer(Modifier.height(10.dp))
            Text(
                "USSD command: ${order.ussdGenerated ?: "generated automatically when executed"}",
                style = MaterialTheme.typography.labelSmall,
            )
            if (recommendedSlot != null) {
                Text("Recommended: SIM $recommendedSlot", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(1, 2).forEach { slot ->
                    val isRecommended = recommendedSlot == slot
                    OutlinedButton(
                        onClick = { onExecute(slot) },
                        enabled = !executing,
                        colors = if (isRecommended) ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.primary) else ButtonDefaults.outlinedButtonColors(),
                    ) {
                        Text(if (isRecommended) "Execute SIM $slot ★" else "Execute SIM $slot")
                    }
                }
            }
        }
    }
}

@Composable
private fun DetailLine(label: String, value: String) {
    Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelSmall)
        Text(value, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium)
    }
}

@Composable
fun StatusChip(order: Order) {
    // "in_progress" is one status in the data model, but reads better to an
    // agent split into whether the USSD string has actually been generated
    // yet (dial about to/already in flight) vs. still waiting on that step —
    // cosmetic only, no change to the underlying OrderStatus.
    val label = when {
        order.status == OrderStatus.PENDING -> "Pending"
        order.status == OrderStatus.IN_PROGRESS -> if (order.ussdGenerated != null) "Delivering" else "Processing"
        order.status == OrderStatus.COMPLETED -> "Completed"
        order.status == OrderStatus.FAILED -> "Failed"
        else -> "Cancelled"
    }
    AssistChip(onClick = {}, label = { Text(label) })
}
