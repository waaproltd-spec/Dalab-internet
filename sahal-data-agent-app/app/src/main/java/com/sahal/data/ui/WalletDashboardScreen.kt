package com.sahal.data.ui

import androidx.compose.foundation.background
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
import com.sahal.data.data.AgentPaymentTransaction
import com.sahal.data.data.WalletBalanceEntry
import com.sahal.data.network.AgentEventBus
import com.sahal.data.network.ApiClient
import com.sahal.data.util.formatApiDateTime
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Same "#RRGGBB" -> ARGB Color parsing sahal_data.customer's colorFromHex
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

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Wallet Balances") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        }
    ) { padding ->
        if (loading) {
            Box(modifier = Modifier.padding(padding).fillMaxSize()) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            }
            return@Scaffold
        }
        LazyColumn(modifier = Modifier.padding(padding).fillMaxSize()) {
            item {
                error?.let {
                    Text(
                        it,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(16.dp),
                    )
                }
                Text(
                    "Balances",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            item {
                if (balances.isEmpty()) {
                    Text(
                        "No SIM balances yet — this device may not have a registered payment SIM.",
                        modifier = Modifier.padding(16.dp),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                } else {
                    Column(modifier = Modifier.padding(horizontal = 16.dp)) {
                        balances.chunked(2).forEach { rowEntries ->
                            Row(modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                                rowEntries.forEachIndexed { i, entry ->
                                    BalanceTile(
                                        entry = entry,
                                        fallbackColor = FALLBACK_TILE_COLORS[
                                            (entry.simSlot - 1).coerceIn(0, FALLBACK_TILE_COLORS.size - 1)
                                        ],
                                        modifier = Modifier
                                            .weight(1f)
                                            .padding(end = if (i == 0 && rowEntries.size > 1) 12.dp else 0.dp),
                                    )
                                }
                                if (rowEntries.size == 1) Spacer(modifier = Modifier.weight(1f))
                            }
                        }
                    }
                }
            }
            item {
                Text(
                    "Latest Transactions",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            if (transactions.isEmpty()) {
                item {
                    Text(
                        "No payment SMS received yet on this device.",
                        modifier = Modifier.padding(16.dp),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            } else {
                items(transactions, key = { it.id }) { tx ->
                    TransactionRow(tx)
                    Divider()
                }
            }
        }
    }
}

@Composable
private fun BalanceTile(entry: WalletBalanceEntry, fallbackColor: Color, modifier: Modifier = Modifier) {
    val color = parseColor(entry.colorHex, fallbackColor)
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(14.dp))
            .background(color)
            .padding(16.dp),
    ) {
        Text(
            entry.providerName ?: "SIM ${entry.simSlot}",
            color = Color.White,
            fontWeight = FontWeight.Bold,
            style = MaterialTheme.typography.titleSmall,
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            "$${"%.2f".format(entry.balance)}",
            color = Color.White,
            fontWeight = FontWeight.Bold,
            style = MaterialTheme.typography.headlineSmall,
        )
    }
}

@Composable
private fun TransactionRow(tx: AgentPaymentTransaction) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(tx.customerPhone ?: "Unknown sender", fontWeight = FontWeight.Bold)
            Text(
                buildString {
                    append(tx.providerName ?: "Unknown provider")
                    tx.smsSender?.let { append(" · SMS from $it") }
                },
                style = MaterialTheme.typography.bodySmall,
            )
            tx.orderId?.let { Text("Order $it", style = MaterialTheme.typography.labelSmall) }
            Text(formatApiDateTime(tx.createdAt), style = MaterialTheme.typography.labelSmall)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(tx.amount?.let { "$${"%.2f".format(it)}" } ?: "—", fontWeight = FontWeight.Bold)
            Spacer(modifier = Modifier.height(4.dp))
            StatusBadge(tx.status)
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
    }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(color.copy(alpha = 0.12f))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(label, color = color, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
    }
}
