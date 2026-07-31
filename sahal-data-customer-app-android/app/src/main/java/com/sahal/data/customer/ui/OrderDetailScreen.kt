package com.sahal.data.customer.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sahal.data.customer.data.CustomerOrder
import com.sahal.data.customer.data.OrderStatus
import com.sahal.data.customer.data.companyLogoRes
import com.sahal.data.customer.network.ApiClient
import com.sahal.data.customer.network.RealtimeClient
import com.sahal.data.customer.prefs.LocalizationManager
import com.sahal.data.customer.util.formatApiDateTime
import kotlinx.coroutines.launch

private val SahalDataIndigo = Color(0xFF1D2E8C)

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
        val compact = LocalConfiguration.current.screenHeightDp < 700
        val heroLogoSize = if (compact) 44.dp else 52.dp
        val heroPadding = if (compact) 14.dp else 18.dp
        val cardPadding = if (compact) 14.dp else 16.dp
        val outerPadding = if (compact) 14.dp else 16.dp

        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = outerPadding, vertical = outerPadding.times(0.75f)),
        ) {
            // Compact hero: logo + name/company/status all on one tight row
            // instead of a tall stacked block, so this alone takes a fraction
            // of the vertical space the previous design did.
            Surface(color = Color(0xFFF6F7FC), shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = heroPadding, vertical = heroPadding.times(0.85f)),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .size(heroLogoSize)
                            .clip(CircleShape)
                            .background(if (logoRes != null) Color.White else SahalDataIndigo),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (logoRes != null) {
                            Image(
                                painter = painterResource(id = logoRes),
                                contentDescription = order.companyName,
                                modifier = Modifier.size(heroLogoSize).clip(CircleShape),
                            )
                        } else {
                            Text(order.companyName.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                        }
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            order.packageName,
                            fontWeight = FontWeight.Bold,
                            fontSize = if (compact) 15.sp else 16.sp,
                            maxLines = 1,
                        )
                        Text(
                            order.companyName,
                            style = MaterialTheme.typography.bodySmall,
                            color = Color.Gray,
                            maxLines = 1,
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    StatusChip(order.status)
                }
            }
            if (copied) {
                Spacer(Modifier.height(4.dp))
                Text("Reference copied to clipboard", style = MaterialTheme.typography.labelSmall, color = SahalDataIndigo)
                LaunchedEffect(copied) {
                    kotlinx.coroutines.delay(1500)
                    copied = false
                }
            }
            Spacer(Modifier.height(if (compact) 10.dp else 12.dp))

            Surface(color = Color(0xFFF6F7FC), shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(cardPadding)) {
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

                    Spacer(Modifier.height(if (compact) 8.dp else 10.dp))
                    SectionLabel("STATUS")
                    DetailRowCustom("Payment Status") { StatusChip(order.status) }
                    DetailRow("Date", formatApiDateTime(order.createdAt))
                }
            }

            Spacer(Modifier.height(10.dp))
            Text(
                statusMessage(order.status),
                style = MaterialTheme.typography.bodySmall,
                color = Color.Gray,
            )
            Spacer(Modifier.height(16.dp))
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
