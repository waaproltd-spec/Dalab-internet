package com.dalab.internet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import com.dalab.internet.util.formatApiDateTime
import com.dalab.internet.data.Transaction
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TransactionHistoryScreen() {
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

    Scaffold(topBar = { TopAppBar(title = { Text("Transaction History") }) }) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            } else if (transactions.isEmpty()) {
                Text("No completed transactions yet.", modifier = Modifier.align(Alignment.Center))
            } else {
                LazyColumn {
                    items(transactions, key = { it.orderId }) { tx ->
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(16.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Column {
                                Text(tx.customerName, fontWeight = FontWeight.Bold)
                                Text("${tx.company} · ${tx.orderId}", style = MaterialTheme.typography.bodySmall)
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text("$${"%.2f".format(tx.amount)}", fontWeight = FontWeight.Bold)
                                Text(formatApiDateTime(tx.completedAt), style = MaterialTheme.typography.labelSmall)
                            }
                        }
                        Divider()
                    }
                }
            }
        }
    }
}
