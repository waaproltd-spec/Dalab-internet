package com.dalab.internet.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Notifications
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
import com.dalab.internet.data.AgentBalanceEntry
import com.dalab.internet.data.Order
import com.dalab.internet.data.OrderStatus
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.R
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.ConnectionState
import com.dalab.internet.notifications.AgentAlertsState
import com.dalab.internet.service.AgentBackgroundService
import com.dalab.internet.support.SupportQueueState
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// DALAB brand — Dark Azure + Soft Blue, shared with the Customer App and
// Admin Dashboard. Re-exported here (under the names this module's screens
// already call them by) from ui/theme/DalabColors.kt, the one place any of
// these hex values is actually defined -- see that file's own header
// comment. DalabGreen stays separate: it's the functional success/
// money-earned color (order-amount text further down), not brand, per the
// shared two-color rule's own carve-out. Internal (not private) so other
// Home-adjacent screens in this module can match the brand exactly.
internal val DalabIndigo = com.dalab.internet.ui.theme.DalabBlue
internal val DalabSoftBlue = com.dalab.internet.ui.theme.DalabSoftBlue
internal val DalabGreen = com.dalab.internet.ui.theme.DalabSuccessGreen

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrdersListScreen(
    onOpenOrder: (Order) -> Unit,
    onOpenAlerts: () -> Unit = {},
) {
    val context = LocalContext.current
    var lastSyncedAt by remember { mutableStateOf<Date?>(null) }
    var balances by remember { mutableStateOf<List<AgentBalanceEntry>>(emptyList()) }
    var balancesLoading by remember { mutableStateOf(true) }
    val connectionState by AgentEventBus.connectionState.collectAsState()
    val unreadAlerts by AgentAlertsState.unreadCount.collectAsState()
    val scope = rememberCoroutineScope()

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
                val notifications = ApiClient.service.getNotifications().body().orEmpty()
                AgentAlertsState.updateUnreadCount(notifications)
            } catch (_: Exception) {
                // Badge just keeps its last known count on failure.
            }
            try {
                // Any agent (online or not) can see how many customers are
                // waiting -- requireSupportActor() only gates claiming, not
                // viewing the queue -- so this is safe to fetch unconditionally.
                val supportQueue = ApiClient.service.getSupportQueue().body().orEmpty()
                SupportQueueState.update(supportQueue)
            } catch (_: Exception) {
                // Badge just keeps its last known count on failure.
            }
        }
    }

    // Real balance data from the same SMS/manual balance pipeline the Super
    // Admin's Balance Dashboard uses -- no mock or hardcoded values. Kept
    // separate from refreshDashboard() above (notifications/support queue)
    // since a balances-fetch failure shouldn't touch those badges' state,
    // and vice versa -- each keeps its last known good value independently.
    fun refreshBalances() {
        scope.launch {
            try {
                balances = ApiClient.service.getAgentBalances().body().orEmpty()
                lastSyncedAt = Date()
            } catch (_: Exception) {
                // Cards just keep showing their last known balances on failure.
            }
            balancesLoading = false
        }
    }
    LaunchedEffect(Unit) { refreshDashboard() }
    LaunchedEffect(Unit) { refreshBalances() }
    // Real-time push: AgentBackgroundService owns the single SSE connection
    // (so it keeps running even off this screen / in the background) and
    // broadcasts here on every order change anywhere (customer app, another
    // agent, the dashboard) instead of this screen opening its own connection.
    LaunchedEffect(Unit) { AgentEventBus.orderEvents.collect { refreshBalances() } }
    LaunchedEffect(Unit) { AgentEventBus.orderEvents.collect { refreshDashboard() } }

    // Home is balance-only now -- the Pending/Completed/All dial queue that
    // used to live below the balance section was removed per product
    // decision (superseded by the Shop/VIP order flow on the Orders tab);
    // onOpenOrder is kept as a parameter only because OrderDetailScreen's
    // navigation wiring in MainActivity still references it.
    Scaffold { padding ->
        LazyColumn(modifier = Modifier.padding(padding).fillMaxSize()) {
            item {
                AgentHomeHeader(
                    agentName = remember { SessionManager.currentAgent()?.name },
                    listeningActive = listeningActive,
                    connectionState = connectionState,
                    lastSyncedAt = lastSyncedAt,
                    unreadAlerts = unreadAlerts,
                    onRefresh = { refreshDashboard(); refreshBalances() },
                    onOpenAlerts = onOpenAlerts,
                )
            }

            item {
                AgentBalanceSection(balances = balances, loading = balancesLoading)
            }
        }
    }
}

// Compact brand header: identity + the two things an agent actually needs
// to see at a glance (is the SMS listener running, is the live connection
// up) collapsed into a single status bar instead of two separate cards.
// Today's Sales/Orders and the Recent Activity feed used to live here too —
// removed as duplicated with the Reports tab (which already has a "Today"
// range) and the orders list immediately below, per the Home redesign.
@Composable
private fun AgentHomeHeader(
    agentName: String?,
    listeningActive: Boolean,
    connectionState: ConnectionState,
    lastSyncedAt: Date?,
    unreadAlerts: Int,
    onRefresh: () -> Unit,
    onOpenAlerts: () -> Unit,
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
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(
                    painter = painterResource(R.drawable.dalab_logo),
                    contentDescription = null,
                    modifier = Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)),
                )
                Spacer(Modifier.width(10.dp))
                Column {
                    Text("DALAB AGENT", color = Color.White, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                    Text(
                        agentName?.let { "Welcome back, $it" } ?: "Welcome back",
                        color = Color.White.copy(alpha = 0.85f),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                NotificationBellButton(unreadCount = unreadAlerts, onClick = onOpenAlerts)
                IconButton(onClick = onRefresh) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = Color.White)
                }
            }
        }

        Spacer(Modifier.height(14.dp))

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
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        if (listeningActive) "SMS Listening — Active" else "SMS Listening — Inactive",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        if (listeningActive) "Monitoring payment SMS" else "Grant SMS permissions in More → Permissions",
                        color = Color.White.copy(alpha = 0.8f),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                Spacer(Modifier.width(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val (dotColor, label) = when (connectionState) {
                        ConnectionState.CONNECTED -> Color(0xFF6FE39A) to "Connected"
                        ConnectionState.CONNECTING -> Color(0xFFF2C200) to "Reconnecting…"
                        ConnectionState.DISCONNECTED -> Color(0xFFF87171) to "Disconnected"
                    }
                    Icon(Icons.Filled.Circle, contentDescription = null, tint = dotColor, modifier = Modifier.size(7.dp))
                    Spacer(Modifier.width(5.dp))
                    Column {
                        Text(label, color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.labelSmall)
                        lastSyncedAt?.let {
                            Text(
                                SimpleDateFormat("HH:mm:ss", Locale.US).format(it),
                                color = Color.White.copy(alpha = 0.7f),
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun NotificationBellButton(unreadCount: Int, onClick: () -> Unit) {
    IconButton(onClick = onClick) {
        BadgedBox(badge = {
            if (unreadCount > 0) {
                Badge(containerColor = Color(0xFFF87171)) {
                    Text(if (unreadCount > 9) "9+" else unreadCount.toString())
                }
            }
        }) {
            Icon(Icons.Filled.Notifications, contentDescription = "Notifications", tint = Color.White)
        }
    }
}

// Home screen's Agent Balance section, replacing the old Wallet/Money
// Exchange quick-action cards -- both are still reachable from the More
// tab (MainActivity's MoreScreen), unchanged. Payment Method (EVC Plus/
// eDahab -- balances used for receiving customer payments) and Payment
// Company (Hormuud/Somnet/Somtel/Amtel -- balances used for sending data/
// airtime) are always shown as their own labeled group, matching the
// reference design, regardless of which ones this specific agent has ever
// dialed through.
@Composable
private fun AgentBalanceSection(balances: List<AgentBalanceEntry>, loading: Boolean) {
    val methodBalances = balances.filter { it.category == "method" }
    val companyBalances = balances.filter { it.category == "company" }

    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        BalanceGroupHeader(title = "Payment Method (${methodBalances.size})")
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
            methodBalances.forEach { entry ->
                BalanceCard(entry = entry, loading = loading, modifier = Modifier.weight(1f))
            }
        }

        Spacer(Modifier.height(22.dp))

        BalanceGroupHeader(title = "Payment Company (${companyBalances.size})")
        Spacer(Modifier.height(10.dp))
        companyBalances.chunked(2).forEach { rowEntries ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                rowEntries.forEach { entry ->
                    BalanceCard(entry = entry, loading = loading, modifier = Modifier.weight(1f))
                }
                if (rowEntries.size == 1) Spacer(modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun BalanceGroupHeader(title: String) {
    Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = DalabIndigo)
}

/** Maps a provider_key to its real bundled brand logo -- see
 * app/src/main/res/drawable/logo_*.png, sourced from the same real brand
 * marks confirmed against the customer-facing apps (never a mock/generic
 * icon). Falls back to the DALAB wordmark only if a 7th key is ever added
 * here without a matching asset. */
@androidx.annotation.DrawableRes
internal fun logoResFor(providerKey: String): Int = when (providerKey) {
    "evc_plus" -> R.drawable.logo_evc_plus
    "edahab" -> R.drawable.logo_edahab
    "hormuud" -> R.drawable.logo_hormuud
    "somnet" -> R.drawable.logo_somnet
    "somtel" -> R.drawable.logo_somtel
    "amtel" -> R.drawable.logo_amtel
    else -> R.drawable.dalab_logo
}

@Composable
private fun BalanceCard(entry: AgentBalanceEntry, loading: Boolean, modifier: Modifier = Modifier) {
    Surface(
        color = Color.White,
        shape = RoundedCornerShape(16.dp),
        shadowElevation = 1.dp,
        modifier = modifier,
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Image(
                painter = painterResource(logoResFor(entry.providerKey)),
                contentDescription = entry.providerName,
                contentScale = ContentScale.Fit,
                alignment = Alignment.CenterStart,
                modifier = Modifier.height(28.dp).fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            Text(
                "${entry.providerName} Balance",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = DalabIndigo,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                if (loading) "…" else "$ ${"%.2f".format(entry.balance)}",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                color = DalabGreen,
            )
        }
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
