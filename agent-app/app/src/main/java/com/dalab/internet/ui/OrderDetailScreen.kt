package com.dalab.internet.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Dialpad
import com.dalab.internet.util.formatApiDateTime
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.Company
import com.dalab.internet.data.Order
import com.dalab.internet.data.OrderStatus
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.VerifyPaymentRequest
import kotlinx.coroutines.launch

/**
 * Builds the service-delivery USSD string from the company's template
 * (e.g. "*712*{number}*{amount}#") by substituting the order's own customer
 * phone number and amount — never a fixed/hardcoded number, since the same
 * template is reused across every order for that provider.
 */
private fun buildServiceUssd(template: String, deliveryNumber: String, amount: Double): String =
    template.replace("{number}", deliveryNumber).replace("{amount}", "%.2f".format(amount))

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrderDetailScreen(order: Order, onBack: () -> Unit, onOrderUpdated: (Order) -> Unit) {
    var current by remember(order) { mutableStateOf(order) }
    var working by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var company by remember { mutableStateOf<Company?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    LaunchedEffect(order.companyId) {
        try {
            company = ApiClient.service.getCompanies().body()?.firstOrNull { it.id == order.companyId }
        } catch (_: Exception) {
            // Send Service section just won't show without a template — no functional loss otherwise.
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
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).padding(20.dp).fillMaxSize()) {

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
                Button(
                    onClick = {
                        working = true
                        scope.launch {
                            try {
                                val response = ApiClient.service.verifyPayment(
                                    current.id, VerifyPaymentRequest()
                                )
                                response.body()?.let {
                                    current = it
                                    onOrderUpdated(it)
                                    message = "Payment verified."
                                } ?: run { message = "Couldn't verify — try again." }
                            } catch (_: Exception) {
                                message = "Network error while verifying."
                            }
                            working = false
                        }
                    },
                    enabled = !working,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (working) "Verifying..." else "Verify Payment")
                }
            }

            if (current.status == OrderStatus.IN_PROGRESS) {
                val deliveryNumber = current.receiverPhone?.takeIf { it.isNotBlank() }
                    ?: current.customerPhone?.takeIf { it.isNotBlank() }
                    ?: current.senderPhone?.takeIf { it.isNotBlank() }
                val template = company?.paymentUssdTemplate?.takeIf { it.isNotBlank() }
                if (template != null && deliveryNumber != null) {
                    val ussd = remember(template, deliveryNumber, current.amount) {
                        buildServiceUssd(template, deliveryNumber, current.amount)
                    }
                    Spacer(Modifier.height(12.dp))
                    SectionLabel("SEND SERVICE")
                    Text(ussd, fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(
                            onClick = { openUssdDialer(context, ussd) },
                            modifier = Modifier.weight(1f),
                        ) {
                            Icon(Icons.Filled.Dialpad, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("Open Dialer")
                        }
                        OutlinedButton(
                            onClick = { copyToClipboard(context, ussd) },
                            modifier = Modifier.weight(1f),
                        ) {
                            Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("Copy")
                        }
                    }
                    Spacer(Modifier.height(16.dp))
                }
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

/**
 * Opens the system dialer pre-filled with the USSD string rather than
 * dialing programmatically — this is a manual fallback the agent reviews
 * and confirms themselves (taps Call), alongside the existing automatic
 * silent dial (UssdDialer.sendUssdRequest) for OEMs/situations where that
 * doesn't fire reliably.
 */
private fun openUssdDialer(context: Context, ussd: String) {
    context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(ussd))))
}

private fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("USSD code", text))
}
