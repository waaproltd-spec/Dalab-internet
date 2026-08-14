package com.dalab.internet.ui

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.util.formatApiDateTime
import com.dalab.internet.data.Transaction
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TransactionHistoryScreen(onBack: (() -> Unit)? = null) {
    var transactions by remember { mutableStateOf<List<Transaction>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        scope.launch {
            try {
                transactions = ApiClient.service.getTransactions().body().orEmpty()
            } catch (_: Exception) {
                // real implementation would surface a retry affordance here
            }
            loading = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Recent Activity") },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
            )
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            } else if (transactions.isEmpty()) {
                Text("No completed transactions yet.", modifier = Modifier.align(Alignment.Center))
            } else {
                Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                    Card(
                        modifier = Modifier.fillMaxWidth().weight(1f),
                        shape = RoundedCornerShape(16.dp),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
                    ) {
                        Column(modifier = Modifier.fillMaxSize()) {
                            TransactionRow(
                                customer = "Customer",
                                detail = "Company · Order",
                                amount = "Amount",
                                completed = "Completed",
                                header = true,
                            )
                            Divider()
                            LazyColumn(modifier = Modifier.weight(1f)) {
                                items(transactions, key = { it.orderId }) { tx ->
                                    TransactionRow(
                                        customer = tx.customerName ?: "Customer",
                                        detail = "${tx.companyName} · ${tx.orderId}",
                                        amount = "$${"%.2f".format(tx.amount)}",
                                        completed = formatApiDateTime(tx.completedAt),
                                    )
                                    Divider()
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TransactionRow(
    customer: String,
    detail: String,
    amount: String,
    completed: String,
    header: Boolean = false,
) {
    val weight = if (header) FontWeight.Bold else FontWeight.Normal
    val style = if (header) MaterialTheme.typography.labelMedium else MaterialTheme.typography.bodyMedium
    val color = if (header) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface

    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1.3f)) {
            Text(customer, style = style, fontWeight = weight, color = color, maxLines = 1)
            if (!header) {
                Text(detail, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            } else {
                Text(detail, style = MaterialTheme.typography.labelSmall, fontWeight = weight, color = color, maxLines = 1)
            }
        }
        Text(
            amount,
            modifier = Modifier.weight(0.8f),
            style = style,
            fontWeight = FontWeight.Bold,
            color = if (header) color else MaterialTheme.colorScheme.primary,
            maxLines = 1,
        )
        Text(
            completed,
            modifier = Modifier.weight(1f),
            style = if (header) style else MaterialTheme.typography.labelSmall,
            fontWeight = weight,
            color = color,
            maxLines = 1,
        )
    }
}
