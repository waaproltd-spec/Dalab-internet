package com.sahal.data.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sahal.data.data.AgentReport
import com.sahal.data.network.ApiClient
import kotlinx.coroutines.launch

private val RANGES = listOf("daily" to "Today", "weekly" to "Week", "monthly" to "Month", "yearly" to "Year")

/** The agent's own completed-sales summary — GET /agent/reports. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReportsScreen() {
    var range by remember { mutableStateOf("weekly") }
    var report by remember { mutableStateOf<AgentReport?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun load() {
        loading = true
        scope.launch {
            try {
                report = ApiClient.service.getReports(range).body()
                error = null
            } catch (_: Exception) {
                error = "Couldn't load your report. Check your connection."
            }
            loading = false
        }
    }

    LaunchedEffect(range) { load() }

    Scaffold(topBar = { TopAppBar(title = { Text("My Reports") }) }) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            Row(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                RANGES.forEach { (value, label) ->
                    FilterChip(selected = range == value, onClick = { range = value }, label = { Text(label) })
                }
            }

            if (error != null) {
                Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp))
            }

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                if (loading) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                } else {
                    val current = report
                    if (current == null) {
                        Text(
                            "No data yet.",
                            modifier = Modifier.align(Alignment.Center),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    } else {
                        Column(modifier = Modifier.fillMaxSize()) {
                            TotalsCard(totalSales = current.totals.totalSales, totalOrders = current.totals.totalOrders)
                            if (current.series.isEmpty()) {
                                Text(
                                    "No completed sales in this range.",
                                    modifier = Modifier.padding(16.dp),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            } else {
                                LazyColumn {
                                    items(current.series, key = { it.day }) { point ->
                                        Row(
                                            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                                            horizontalArrangement = Arrangement.SpaceBetween,
                                        ) {
                                            Text(point.day)
                                            Text("${point.orders} orders · $${"%.2f".format(point.sales)}")
                                        }
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
}

@Composable
private fun TotalsCard(totalSales: Double, totalOrders: Int) {
    Card(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(20.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("$${"%.2f".format(totalSales)}", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text("All-time sales", style = MaterialTheme.typography.labelMedium)
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("$totalOrders", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text("All-time orders", style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}
