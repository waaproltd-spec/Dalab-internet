package com.dalab.internet.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.ExchangeOrder
import com.dalab.internet.data.ExchangeOrderStatus
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.ExchangeDialAttemptStartRequest
import com.dalab.internet.network.ExchangeStepRequest
import com.dalab.internet.ussd.ExchangeUssdOrchestrator
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExchangeOrderDetailScreen(order: ExchangeOrder, onBack: () -> Unit, onOrderUpdated: (ExchangeOrder) -> Unit) {
    var current by remember(order) { mutableStateOf(order) }
    var working by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf(false) }

    // Manual fallback state — only populated once the agent explicitly asks
    // for it. The PIN is held only in this screen's in-memory state, shown
    // masked by default, and never written anywhere else.
    var manualAttemptId by remember { mutableStateOf<String?>(null) }
    var manualUssd by remember { mutableStateOf<String?>(null) }
    var manualPin by remember { mutableStateOf<String?>(null) }
    var pinVisible by remember { mutableStateOf(false) }

    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val orchestrator = remember { ExchangeUssdOrchestrator(context) }

    fun refreshFromList() {
        scope.launch {
            try {
                ApiClient.service.getExchangeOrders().body()?.firstOrNull { it.id == current.id }?.let {
                    current = it
                    onOrderUpdated(it)
                }
            } catch (_: Exception) {
                // Keep showing the last known state if the refresh fails.
            }
        }
    }

    fun runAutomatedPayout() {
        working = true
        message = null
        scope.launch {
            val result = orchestrator.executePayout(current)
            message = "${result.outcome}${result.message?.let { " — $it" } ?: ""}"
            refreshFromList()
            working = false
        }
    }

    fun startManual() {
        working = true
        message = null
        scope.launch {
            try {
                val response = ApiClient.service.startExchangeDialAttempt(current.id, ExchangeDialAttemptStartRequest(1))
                val body = response.body()
                if (response.isSuccessful && body != null && body.pin != null) {
                    manualAttemptId = body.id
                    manualUssd = body.step1UssdString
                    manualPin = body.pin
                } else {
                    message = "Could not get payout details — check the order's status on the dashboard."
                }
            } catch (e: Exception) {
                message = "Network error: ${e.message}"
            }
            working = false
        }
    }

    fun reportManualResult(success: Boolean) {
        val attemptId = manualAttemptId ?: return
        working = true
        scope.launch {
            try {
                ApiClient.service.reportExchangeStep1(attemptId, ExchangeStepRequest("step1_success", "Manual payout"))
                ApiClient.service.reportExchangeStep2(
                    attemptId,
                    ExchangeStepRequest(if (success) "success" else "failed", "Reported manually by agent", isFinalAttempt = true),
                )
                message = if (success) "Marked as completed." else "Marked as failed."
                manualAttemptId = null
                manualUssd = null
                manualPin = null
                pinVisible = false
                refreshFromList()
            } catch (e: Exception) {
                message = "Network error while reporting: ${e.message}"
            }
            working = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Exchange ${current.id}") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    IconButton(onClick = {
                        val clipboard = context.getSystemService(ClipboardManager::class.java)
                        clipboard?.setPrimaryClip(ClipData.newPlainText("Exchange ID", current.id))
                        copied = true
                    }) {
                        Icon(Icons.Filled.ContentCopy, contentDescription = "Copy exchange ID")
                    }
                },
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).padding(20.dp).fillMaxSize()) {

            if (copied) {
                Text("Exchange ID copied to clipboard", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.height(8.dp))
                LaunchedEffect(copied) {
                    kotlinx.coroutines.delay(1500)
                    copied = false
                }
            }

            SectionLabel("EXCHANGE")
            DetailRow("From", current.fromWalletName ?: current.fromWalletId)
            DetailRow("To", current.toWalletName ?: current.toWalletId)
            DetailRow("Sent", "$${"%.2f".format(current.amountSent)}")
            DetailRow("Receives", "$${"%.2f".format(current.amountReceived)}")

            Spacer(Modifier.height(20.dp))
            SectionLabel("CONTACT NUMBERS")
            DetailRow("Sender", current.senderPhone)
            DetailRow("Receiver", current.receiverPhone)

            Spacer(Modifier.height(20.dp))
            SectionLabel("STATUS")
            ExchangeStatusChip(current.status)

            Spacer(Modifier.height(28.dp))

            if (message != null) {
                Text(message!!, color = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.height(12.dp))
            }

            if (current.status == ExchangeOrderStatus.IN_PROGRESS) {
                Button(onClick = { runAutomatedPayout() }, enabled = !working, modifier = Modifier.fillMaxWidth()) {
                    Text(if (working) "Working..." else "Start Automated Payout")
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    "Dials the carrier automatically and enters the PIN when prompted. Requires " +
                        "Money Exchange Setup to be enabled (More > Money Exchange > gear icon).",
                    style = MaterialTheme.typography.labelSmall,
                )

                Spacer(Modifier.height(20.dp))
                Divider()
                Spacer(Modifier.height(16.dp))
                SectionLabel("MANUAL PAYOUT (FALLBACK)")

                if (manualUssd == null) {
                    OutlinedButton(onClick = { startManual() }, enabled = !working, modifier = Modifier.fillMaxWidth()) {
                        Text("Get USSD Code + PIN for Manual Dial")
                    }
                } else {
                    Text("USSD code (step 1 — dial this, then wait for the PIN prompt):", style = MaterialTheme.typography.labelSmall)
                    Text(manualUssd ?: "", fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(10.dp))
                    Text("PIN (step 2 — enter only when the carrier asks for it):", style = MaterialTheme.typography.labelSmall)
                    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        Text(if (pinVisible) (manualPin ?: "") else "••••", fontWeight = FontWeight.Bold)
                        IconButton(onClick = { pinVisible = !pinVisible }) {
                            Icon(if (pinVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility, contentDescription = "Toggle PIN visibility")
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        Button(onClick = { reportManualResult(true) }, enabled = !working, modifier = Modifier.weight(1f)) {
                            Text("Mark Complete")
                        }
                        OutlinedButton(onClick = { reportManualResult(false) }, enabled = !working, modifier = Modifier.weight(1f)) {
                            Text("Report Failure")
                        }
                    }
                }
            }

            if (current.status == ExchangeOrderStatus.COMPLETED) {
                Text(
                    "This exchange was completed${current.completedAt?.let { " at $it" } ?: ""}.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }

            if (current.status == ExchangeOrderStatus.FAILED) {
                Text("This exchange failed. Check Exchange History on the dashboard for details.", style = MaterialTheme.typography.bodyMedium)
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
