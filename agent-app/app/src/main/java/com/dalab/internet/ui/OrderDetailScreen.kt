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
import com.dalab.internet.network.VerifyPaymentRequest
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
