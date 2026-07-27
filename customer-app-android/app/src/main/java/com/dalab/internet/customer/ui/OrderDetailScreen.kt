package com.dalab.internet.customer.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.OrderStatus
import com.dalab.internet.customer.data.companyLogoRes
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.RealtimeClient
import com.dalab.internet.customer.util.formatApiDateTime
import kotlinx.coroutines.launch

private val DalabIndigo = Color(0xFF1D2E8C)

/**
 * Starts from the order object the caller already has (avoids a blank
 * loading flash) but stays live from then on — subscribes to the same SSE
 * stream OrdersScreen uses and re-fetches by id on every event, so a
 * customer watching this screen sees the status flip to "Completed" without
 * navigating back and forth.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrderDetailScreen(initialOrder: CustomerOrder, onBack: () -> Unit) {
    var order by remember { mutableStateOf(initialOrder) }
    var copied by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    fun refresh() {
        scope.launch {
            try {
                ApiClient.service.getOrder(initialOrder.id).body()?.let { order = it }
            } catch (_: Exception) {
                // Leave the previous state in place — the next SSE event retries.
            }
        }
    }

    DisposableEffect(Unit) {
        val realtime = RealtimeClient(path = "orders/stream") { refresh() }
        realtime.connect()
        onDispose { realtime.disconnect() }
    }

    val logoRes = remember(order.companyId) { companyLogoRes(order.companyId) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Order Details") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    IconButton(onClick = {
                        val clipboard = context.getSystemService(ClipboardManager::class.java)
                        clipboard?.setPrimaryClip(ClipData.newPlainText("Order reference", order.id))
                        copied = true
                    }) {
                        Icon(Icons.Filled.ContentCopy, contentDescription = "Copy order reference")
                    }
                },
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier.padding(padding).padding(20.dp).fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                modifier = Modifier
                    .size(72.dp)
                    .clip(CircleShape)
                    .background(if (logoRes != null) Color.White else DalabIndigo),
                contentAlignment = Alignment.Center,
            ) {
                if (logoRes != null) {
                    Image(
                        painter = painterResource(id = logoRes),
                        contentDescription = order.companyName,
                        modifier = Modifier.size(72.dp).clip(CircleShape),
                    )
                } else {
                    Text(order.companyName.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 26.sp)
                }
            }
            Spacer(Modifier.height(10.dp))
            Text(order.packageName, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Text(order.companyName, style = MaterialTheme.typography.bodyMedium, color = Color.Gray)
            Spacer(Modifier.height(12.dp))
            StatusChip(order.status)
            if (copied) {
                Spacer(Modifier.height(6.dp))
                Text("Reference copied to clipboard", style = MaterialTheme.typography.labelSmall, color = DalabIndigo)
                LaunchedEffect(copied) {
                    kotlinx.coroutines.delay(1500)
                    copied = false
                }
            }
            Spacer(Modifier.height(20.dp))

            Surface(color = Color(0xFFF6F7FC), shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(18.dp)) {
                    SectionLabel("SERVICE DETAILS")
                    DetailRowCustom("Reference") {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(order.id, fontWeight = FontWeight.Medium)
                            Spacer(Modifier.width(6.dp))
                            IconButton(
                                onClick = {
                                    val clipboard = context.getSystemService(ClipboardManager::class.java)
                                    clipboard?.setPrimaryClip(ClipData.newPlainText("Order reference", order.id))
                                    copied = true
                                },
                                modifier = Modifier.size(20.dp),
                            ) {
                                Icon(Icons.Filled.ContentCopy, contentDescription = "Copy reference", modifier = Modifier.size(14.dp))
                            }
                        }
                    }
                    DetailRow("Service", order.packageName)
                    order.senderPhone?.takeIf { it.isNotBlank() }?.let { DetailRow("Sender Number", it) }
                    order.receiverPhone?.takeIf { it.isNotBlank() }?.let { DetailRow("Receiver Number", it) }
                    DetailRow("Payment Method", order.paymentMethod ?: "—")
                    DetailRow("Amount", "$${"%.2f".format(order.amount)}")

                    Spacer(Modifier.height(14.dp))
                    SectionLabel("STATUS")
                    DetailRowCustom("Payment Status") { StatusChip(order.status) }
                    DetailRow("Date", formatApiDateTime(order.createdAt))
                }
            }

            Spacer(Modifier.height(12.dp))
            Text(statusMessage(order.status), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

private fun statusMessage(status: OrderStatus): String = when (status) {
    OrderStatus.PENDING -> "Waiting for payment confirmation."
    OrderStatus.IN_PROGRESS -> "Payment confirmed — your order is being processed."
    OrderStatus.COMPLETED -> "Your package has been activated."
    OrderStatus.FAILED -> "This order failed. Please try again or contact support."
    OrderStatus.CANCELLED -> "This order was cancelled."
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = Color.Gray)
    Spacer(Modifier.height(8.dp))
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = Color.Gray)
        Text(value, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun DetailRowCustom(label: String, value: @Composable () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = Color.Gray)
        value()
    }
}
