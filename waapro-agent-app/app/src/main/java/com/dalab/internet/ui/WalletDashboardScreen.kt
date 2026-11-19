package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Sync
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.AgentPaymentTransaction
import com.dalab.internet.data.WalletBalanceEntry
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.network.ApiClient
import com.dalab.internet.util.formatApiDateTime
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Same "#RRGGBB" -> ARGB Color parsing dalab_internet.customer's colorFromHex
 * does — falls back to a rotating brand-neutral color when a provider has no
 * colorHex set (or it fails to parse) rather than rendering an unstyled tile. */
private fun parseColor(hex: String?, fallback: Color): Color {
    if (hex.isNullOrBlank()) return fallback
    return try {
        val clean = hex.removePrefix("#")
        val withAlpha = if (clean.length == 6) "FF$clean" else clean
        Color(withAlpha.toLong(16).toInt())
    } catch (e: Exception) {
        fallback
    }
}

private val FALLBACK_TILE_COLORS = listOf(
    Color(0xFF16A34A), Color(0xFF1D4ED8), Color(0xFFC81E2C), Color(0xFFF2C200),
)

/**
 * Reseller-style "monitor everything in one place" screen: this device's own
 * SIM wallet balances, plus every incoming payment confirmation SMS
 * (matched or not, dialed or not) as a live transaction feed.
 *
 * Stays live via [AgentEventBus.orderEvents] — the same always-on SSE
 * connection AgentBackgroundService keeps open for order updates also
 * carries sms_log.created and payment_transaction.updated (the backend
 * broadcasts every real-time signal through one global pub/sub), so no
 * separate stream is needed here, just a re-fetch on any event. A periodic
 * fallback poll (8s, matching the Super Admin's own Payment Transactions
 * panel refresh cadence) covers the gap while the SSE connection is
 * reconnecting.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WalletDashboardScreen(onBack: () -> Unit) {
    var balances by remember { mutableStateOf<List<WalletBalanceEntry>>(emptyList()) }
    var transactions by remember { mutableStateOf<List<AgentPaymentTransaction>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
        try {
            balances = ApiClient.service.getWalletBalances().body().orEmpty()
            transactions = ApiClient.service.getAgentPaymentTransactions(limit = 100).body().orEmpty()
            error = null
        } catch (e: Exception) {
            error = "Could not load wallet data — check your connection."
        }
        loading = false
    }

    LaunchedEffect(Unit) { refresh() }

    LaunchedEffect(Unit) {
        AgentEventBus.orderEvents.collect { scope.launch { refresh() } }
    }

    LaunchedEffect(Unit) {
        while (true) {
            delay(8_000L)
            refresh()
        }
    }

    val total = balances.sumOf { it.balance }
    val waiting = transactions.count { it.status == "pending" || it.status == "processing" }
    var filter by remember { mutableStateOf(0) } // 0 all, 1 waiting, 2 completed, 3 failed
    val shown = when (filter) {
        1 -> transactions.filter { it.status == "pending" || it.status == "processing" }
        2 -> transactions.filter { it.status == "completed" }
        3 -> transactions.filter { it.status == "failed" || it.status == "duplicate_blocked" }
        else -> transactions
    }

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
                    Text("Wallet Balances", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp, modifier = Modifier.weight(1f))
                    IconButton(onClick = { scope.launch { refresh() } }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = Color.White) }
                }
                Column(Modifier.padding(horizontal = 8.dp)) {
                    Text("Total balance", color = Color.White.copy(alpha = 0.8f), fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
                    Text("$" + "%,.2f".format(total), color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 32.sp)
                    Text(
                        "${balances.size} SIM${if (balances.size == 1) "" else "s"} · $waiting waiting",
                        color = Color.White.copy(alpha = 0.8f), fontSize = 12.5.sp,
                    )
                }
            }
        }
    ) { padding ->
        if (loading) {
            Box(modifier = Modifier.padding(padding).fillMaxSize()) {
                CircularProgressIndicator(color = WaaproNavy, modifier = Modifier.align(Alignment.Center))
            }
            return@Scaffold
        }
        LazyColumn(
            modifier = Modifier.padding(padding).fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
            if (balances.isEmpty()) {
                item { Text("No SIM balances yet.", color = WaaproMuted) }
            } else {
                items(balances.chunked(2)) { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                        row.forEach { entry ->
                            BalanceTile(
                                entry = entry,
                                fallbackColor = FALLBACK_TILE_COLORS[(entry.simSlot - 1).coerceIn(0, FALLBACK_TILE_COLORS.size - 1)],
                                modifier = Modifier.weight(1f),
                            )
                        }
                        if (row.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
            item {
                Spacer(Modifier.height(6.dp))
                Text("Latest transactions", fontWeight = FontWeight.ExtraBold, fontSize = 17.sp)
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) {
                    listOf("All", "Waiting", "Completed", "Failed").forEachIndexed { i, label ->
                        FilterChip(selected = filter == i, onClick = { filter = i }, label = { Text(label, fontWeight = FontWeight.Bold) })
                    }
                }
            }
            if (shown.isEmpty()) {
                item { Text("No payment SMS here yet.", color = WaaproMuted, modifier = Modifier.padding(vertical = 12.dp)) }
            } else {
                items(shown, key = { it.id }) { tx -> TransactionRow(tx) }
            }
        }
    }
}

/** One SIM: its network colour, the network, which SIM, the balance; a mark when low. */
@Composable
private fun BalanceTile(entry: WalletBalanceEntry, fallbackColor: Color, modifier: Modifier = Modifier) {
    val color = parseColor(entry.colorHex, fallbackColor)
    val low = entry.balance < entry.lowBalanceThreshold
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(20.dp))
            .background(Brush.linearGradient(listOf(color, lerp(color, Color.Black, 0.25f))))
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(entry.providerName ?: "SIM ${entry.simSlot}", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp, modifier = Modifier.weight(1f), maxLines = 1)
            Surface(shape = RoundedCornerShape(50), color = Color.White.copy(alpha = 0.22f)) {
                Text("SIM ${entry.simSlot}", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 11.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
            }
        }
        Spacer(Modifier.height(8.dp))
        Text("$${"%.2f".format(entry.balance)}", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 26.sp)
        entry.phoneNumber?.takeIf { it.isNotBlank() }?.let {
            Text(it.filter { c -> c.isDigit() }.takeLast(9), color = Color.White.copy(alpha = 0.85f), fontSize = 12.sp)
        }
        if (low) {
            Spacer(Modifier.height(6.dp))
            Surface(shape = RoundedCornerShape(50), color = Color.White) {
                Text("Low balance", color = Color(0xFFDC2626), fontWeight = FontWeight.Bold, fontSize = 11.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
            }
        }
    }
}

/** One payment SMS: who paid, network and sender, order, time, amount and state. */
@Composable
private fun TransactionRow(tx: AgentPaymentTransaction) {
    val (icon, ink) = when (tx.status) {
        "completed" -> Icons.Filled.CheckCircle to Color(0xFF15803D)
        "failed", "duplicate_blocked" -> Icons.Filled.ErrorOutline to Color(0xFFC81E2C)
        "processing" -> Icons.Filled.Sync to Color(0xFF1D4ED8)
        else -> Icons.Filled.Schedule to Color(0xFFB45309)
    }
    Surface(
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 1.dp,
        modifier = Modifier.fillMaxWidth().border(1.dp, WaaproBorder, RoundedCornerShape(18.dp)),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(ink.copy(alpha = 0.12f)), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = ink, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(tx.customerPhone ?: "Unknown sender", fontWeight = FontWeight.ExtraBold, fontSize = 15.sp, maxLines = 1)
                Text(
                    buildString {
                        append(tx.providerName ?: "Unknown network")
                        tx.smsSender?.let { append(" · SMS $it") }
                    },
                    color = WaaproMuted, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    (tx.orderId?.let { "$it · " } ?: "") + formatApiDateTime(tx.createdAt),
                    color = WaaproMuted, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.width(8.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text(tx.amount?.let { "$${"%.2f".format(it)}" } ?: "—", fontWeight = FontWeight.ExtraBold, fontSize = 16.sp)
                Spacer(modifier = Modifier.height(4.dp))
                StatusBadge(tx.status)
            }
        }
    }
}

@Composable
private fun StatusBadge(status: String) {
    val (label, color) = when (status) {
        "pending" -> "Pending" to Color(0xFFB45309)
        "processing" -> "Verified" to Color(0xFF1D4ED8)
        "completed" -> "Completed" to Color(0xFF15803D)
        "failed" -> "Failed" to Color(0xFFC81E2C)
        "duplicate_blocked" -> "Duplicate" to Color(0xFF6B7280)
        else -> status to Color(0xFF6B7280)
    }.let { (l, c) -> l to if (com.dalab.internet.ui.theme.isAgentDark) androidx.compose.ui.graphics.lerp(c, Color.White, 0.45f) else c }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(color.copy(alpha = 0.12f))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(label, color = color, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
    }
}
