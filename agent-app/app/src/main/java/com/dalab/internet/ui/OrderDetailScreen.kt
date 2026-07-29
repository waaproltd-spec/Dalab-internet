package com.dalab.internet.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import com.dalab.internet.util.formatApiDateTime
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.Order
import com.dalab.internet.data.OrderStatus
import com.dalab.internet.network.ApiClient
import com.dalab.internet.ussd.SimRoutingRepository
import com.dalab.internet.ussd.UssdOrchestrator
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrderDetailScreen(order: Order, onBack: () -> Unit, onOrderUpdated: (Order) -> Unit) {
    var current by remember(order) { mutableStateOf(order) }
    var working by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val orchestrator = remember { UssdOrchestrator(context) }
    val recommendedSlot = remember(current.companyId) { SimRoutingRepository.simSlotFor(current.companyId) }

    // Verifying payment alone never dials — executeManually does both
    // (verify-payment, then generate+dial the USSD string), same call the
    // Orders list's "Execute SIM" buttons already use. Safe to call again
    // even if the order is already in_progress: verify-payment's status
    // guard just no-ops the transition, and USSD generation is idempotent —
    // this is exactly how a stuck order (verified, in_progress, never
    // dialed) gets a way forward instead of a dead end.
    fun dial(simSlot: Int) {
        working = true
        message = null
        scope.launch {
            val result = orchestrator.executeManually(current.id, simSlot)
            message = "${result.outcome}${result.responseMessage?.let { " — $it" } ?: ""}"
            try {
                ApiClient.service.getOrder(current.id).body()?.let {
                    current = it
                    onOrderUpdated(it)
                }
            } catch (_: Exception) {
                // Keep showing the dial result above even if the refresh fails.
            }
            working = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Order ${current.id}") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = {
                        val clipboard = context.getSystemService(ClipboardManager::class.java)
                        clipboard?.setPrimaryClip(ClipData.newPlainText("Order ID", current.id))
                        copied = true
                    }) {
                        Icon(Icons.Filled.ContentCopy, contentDescription = "Copy order ID")
                    }
                },
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).padding(20.dp).fillMaxSize()) {

            if (copied) {
                Text("Order ID copied to clipboard", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.height(8.dp))
                LaunchedEffect(copied) {
                    kotlinx.coroutines.delay(1500)
                    copied = false
                }
            }

            SectionLabel("CUSTOMER")
            DetailRow("Name", current.customerName ?: "Not provided")
            DetailRow("Phone", current.customerPhone ?: "Not provided")

            Spacer(Modifier.height(20.dp))
            SectionLabel("PACKAGE")
            DetailRow("Provider", current.companyName)
            DetailRow("Package", current.packageName)
            DetailRow("Amount", "$${"%.2f".format(current.amount)}")

            Spacer(Modifier.height(20.dp))
            SectionLabel("STATUS")
            StatusChip(current.status)

            Spacer(Modifier.height(28.dp))

            if (message != null) {
                Text(message!!, color = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.height(12.dp))
            }

            if (current.status == OrderStatus.PENDING) {
                Text(
                    "Verifying payment also generates and dials the USSD code — pick the SIM this order's provider is routed to.",
                    style = MaterialTheme.typography.labelSmall,
                )
                if (recommendedSlot != null) {
                    Spacer(Modifier.height(4.dp))
                    Text("Recommended: SIM $recommendedSlot", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    listOf(1, 2).forEach { slot ->
                        val isRecommended = recommendedSlot == slot
                        OutlinedButton(
                            onClick = { dial(slot) },
                            enabled = !working,
                            modifier = Modifier.weight(1f),
                            colors = if (isRecommended) ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.primary) else ButtonDefaults.outlinedButtonColors(),
                        ) {
                            Text(if (working) "Working..." else if (isRecommended) "Verify + Dial SIM $slot ★" else "Verify + Dial SIM $slot")
                        }
                    }
                }
            }

            if (current.status == OrderStatus.IN_PROGRESS) {
                Spacer(Modifier.height(12.dp))
                // Covers the order that's already verified but was never
                // actually dialed (e.g. verified before this screen dialed on
                // verify, or a dial that exhausted its retries) — same
                // executeManually call as above, safe to re-run.
                Text("No confirmation the USSD was dialed yet? Retry it here.", style = MaterialTheme.typography.labelSmall)
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    listOf(1, 2).forEach { slot ->
                        val isRecommended = recommendedSlot == slot
                        OutlinedButton(
                            onClick = { dial(slot) },
                            enabled = !working,
                            modifier = Modifier.weight(1f),
                            colors = if (isRecommended) ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.primary) else ButtonDefaults.outlinedButtonColors(),
                        ) {
                            Text(if (working) "Working..." else if (isRecommended) "Dial SIM $slot ★" else "Dial SIM $slot")
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = {
                        working = true
                        scope.launch {
                            try {
                                val response = ApiClient.service.completeOrder(current.id)
                                response.body()?.let {
                                    current = it
                                    onOrderUpdated(it)
                                    message = "Order marked as completed."
                                } ?: run { message = "Couldn't complete — try again." }
                            } catch (_: Exception) {
                                message = "Network error while completing."
                            }
                            working = false
                        }
                    },
                    enabled = !working,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (working) "Completing..." else "Mark as Completed")
                }
            }

            if (current.status == OrderStatus.COMPLETED) {
                Text(
                    "This order was completed${current.completedAt?.let { " at ${formatApiDateTime(it)}" } ?: ""}.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
    Spacer(Modifier.height(6.dp))
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(value, fontWeight = FontWeight.Medium)
    }
}
