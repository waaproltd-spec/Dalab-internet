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
import com.dalab.internet.network.SimBalanceCheck
import com.dalab.internet.ui.theme.DalabDangerRed
import com.dalab.internet.ui.theme.DalabWarningAmber
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.filled.Warning
import kotlinx.coroutines.launch
import com.dalab.internet.ui.i18n.Text

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
    val recommendedSlot = remember(current.companyId) { SimRoutingRepository.cachedSlotFor(current.companyId) }

    // Insufficient SIM Balance alert: the backend's check for each SIM slot
    // (GET .../sim-balance-check), fetched before the agent can dial. The
    // backend enforces the same check when the dial starts, so this screen
    // only has to explain it -- it can't be bypassed from here.
    val balanceChecks = remember(current.id) { mutableStateMapOf<Int, SimBalanceCheck>() }
    var balanceCheckFailed by remember(current.id) { mutableStateOf(false) }
    var confirmSlot by remember { mutableStateOf<Int?>(null) }
    suspend fun refreshBalanceChecks() {
        var failed = false
        for (slot in listOf(1, 2)) {
            try {
                ApiClient.service.getSimBalanceCheck(current.id, slot).body()?.let { balanceChecks[slot] = it } ?: run { failed = true }
            } catch (_: Exception) {
                failed = true
            }
        }
        balanceCheckFailed = failed && balanceChecks.isEmpty()
    }
    LaunchedEffect(current.id, current.status) {
        if (current.status == OrderStatus.PENDING || current.status == OrderStatus.IN_PROGRESS) refreshBalanceChecks()
    }

    // Verifying payment alone never dials — executeManually does both
    // (verify-payment, then generate+dial the USSD string), same call the
    // Orders list's "Execute SIM" buttons already use. Safe to call again
    // even if the order is already in_progress: verify-payment's status
    // guard just no-ops the transition, and USSD generation is idempotent —
    // this is exactly how a stuck order (verified, in_progress, never
    // dialed) gets a way forward instead of a dead end.
    fun dial(simSlot: Int, confirmUnknownBalance: Boolean = false) {
        working = true
        message = null
        scope.launch {
            val result = orchestrator.executeManually(current.id, simSlot, confirmUnknownBalance = confirmUnknownBalance, fromUi = true)
            message = "${result.outcome}${result.responseMessage?.let { " — $it" } ?: ""}"
            try {
                ApiClient.service.getOrder(current.id).body()?.let {
                    current = it
                    onOrderUpdated(it)
                }
            } catch (_: Exception) {
                // Keep showing the dial result above even if the refresh fails.
            }
            refreshBalanceChecks()
            working = false
        }
    }

    // Insufficient -> no dial at all (button disabled); unknown/outdated ->
    // the agent must confirm first; sufficient -> dial straight away.
    fun onDialTapped(slot: Int) {
        when (balanceChecks[slot]?.status) {
            "insufficient" -> message = balanceChecks[slot]?.message
            "unknown", "outdated" -> confirmSlot = slot
            else -> dial(slot)
        }
    }

    confirmSlot?.let { slot ->
        val check = balanceChecks[slot]
        AlertDialog(
            onDismissRequest = { confirmSlot = null },
            title = { Text(if (check?.status == "outdated") "SIM Balance Outdated" else "SIM Balance Unknown") },
            text = { Text(check?.message ?: "The SIM balance couldn't be confirmed.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmSlot = null
                    dial(slot, confirmUnknownBalance = true)
                }) { Text("I checked the SIM — dial anyway") }
            },
            dismissButton = { TextButton(onClick = { confirmSlot = null }) { Text("Cancel") } },
        )
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
            StatusChip(current)

            Spacer(Modifier.height(28.dp))

            if (current.status == OrderStatus.PENDING || current.status == OrderStatus.IN_PROGRESS) {
                // The SIM this order's provider is routed to first; the other
                // slot's warning shows only if that's the one with a problem.
                val shownSlot = recommendedSlot ?: balanceChecks.keys.minOrNull()
                val shown = shownSlot?.let { balanceChecks[it] }
                if (shown != null && !shown.ok) {
                    SimBalanceWarningCard(shown)
                    Spacer(Modifier.height(16.dp))
                } else if (balanceCheckFailed) {
                    Text(
                        "Couldn't check the SIM balance right now — it will be checked again before dialing.",
                        style = MaterialTheme.typography.labelSmall,
                        color = DalabWarningAmber,
                    )
                    Spacer(Modifier.height(12.dp))
                }
            }

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
                            onClick = { onDialTapped(slot) },
                            enabled = !working && balanceChecks[slot]?.status != "insufficient",
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
                            onClick = { onDialTapped(slot) },
                            enabled = !working && balanceChecks[slot]?.status != "insufficient",
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

/** The Insufficient / Unknown / Outdated SIM Balance warning, with every
 * figure the agent needs before recharging the company SIM. */
@Composable
private fun SimBalanceWarningCard(check: SimBalanceCheck) {
    val insufficient = check.status == "insufficient"
    val accent = if (insufficient) DalabDangerRed else DalabWarningAmber
    val title = when (check.status) {
        "insufficient" -> "Insufficient SIM Balance!"
        "outdated" -> "SIM Balance Outdated"
        else -> "SIM Balance Unknown"
    }
    fun usd(v: Double?) = v?.let { "$" + "%.2f".format(it) } ?: "Unknown"
    Surface(
        color = accent.copy(alpha = 0.10f),
        shape = RoundedCornerShape(14.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, accent.copy(alpha = 0.6f)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = accent)
                Spacer(Modifier.width(8.dp))
                Text(title, fontWeight = FontWeight.Bold, color = accent, style = MaterialTheme.typography.titleMedium)
            }
            Spacer(Modifier.height(10.dp))
            DetailRow("Customer name", check.customerName)
            DetailRow("Company", check.companyName + (check.simSlot?.let { " (SIM $it)" } ?: ""))
            DetailRow("Requested amount", usd(check.requestedAmount))
            DetailRow("Available SIM balance", usd(check.availableBalance))
            if (insufficient) DetailRow("Missing amount", usd(check.missingAmount))
            check.message?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
