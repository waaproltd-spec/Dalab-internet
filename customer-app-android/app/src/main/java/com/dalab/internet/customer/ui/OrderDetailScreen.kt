package com.dalab.internet.customer.ui

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
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Schedule
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
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.OrderStatus
import com.dalab.internet.customer.data.companyLogoRes
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.RealtimeClient
import com.dalab.internet.customer.network.UpdateScheduleRequest
import com.dalab.internet.customer.prefs.LocalizationManager
import com.dalab.internet.customer.util.PaymentDialUtil
import com.dalab.internet.customer.util.formatApiDateTime
import com.dalab.internet.customer.util.parseApiDate
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId

private val DalabIndigo = Color(0xFF1D2E8C)
private val SchedulePurple = Color(0xFF7C3AED)

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

    // Schedule Recharge: edit / cancel, only meaningful while the schedule
    // hasn't executed yet (ussdGenerated still null) and no cancellation
    // request is already pending — the backend re-enforces both conditions.
    var showDatePicker by remember { mutableStateOf(false) }
    var showTimePicker by remember { mutableStateOf(false) }
    var editDate by remember { mutableStateOf<LocalDate?>(null) }
    var editTime by remember { mutableStateOf<LocalTime?>(null) }
    var scheduleActionBusy by remember { mutableStateOf(false) }
    var scheduleActionError by remember { mutableStateOf<String?>(null) }
    var scheduleActionMessage by remember { mutableStateOf<String?>(null) }

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
                            .background(if (logoRes != null) Color.White else DalabIndigo),
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
                Text("Reference copied to clipboard", style = MaterialTheme.typography.labelSmall, color = DalabIndigo)
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

            val scheduledAt = order.scheduledAt
            if (scheduledAt != null) {
                Spacer(Modifier.height(10.dp))
                Surface(color = Color(0xFFF3EEFC), shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(cardPadding)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.Schedule, contentDescription = null, tint = SchedulePurple, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(
                                LocalizationManager.tr("Scheduled Recharge", "Dib-u-shubid la qorsheeyay"),
                                fontWeight = FontWeight.Bold,
                                color = SchedulePurple,
                            )
                        }
                        Spacer(Modifier.height(6.dp))
                        DetailRow(
                            LocalizationManager.tr("Scheduled for", "Waqtiga la qorsheeyay"),
                            formatApiDateTime(scheduledAt),
                        )

                        val pendingExecution = order.ussdGenerated == null
                        val cancellationRequestedAt = order.cancellationRequestedAt
                        if (pendingExecution && cancellationRequestedAt == null) {
                            // Checkout skips the payment dial for a future-scheduled
                            // order (see CheckoutScreen.kt) -- this is the only place
                            // left to trigger it once the scheduled time arrives. A
                            // 15s-ticking clock is UI-gating only: the backend's own
                            // pipeline is what actually verifies/completes payment
                            // whenever it's sent, so a wrong client clock is never a
                            // correctness risk, only a display nuisance.
                            if (order.status == OrderStatus.PENDING) {
                                Spacer(Modifier.height(10.dp))
                                var nowTick by remember { mutableStateOf(java.util.Date()) }
                                LaunchedEffect(scheduledAt) {
                                    while (true) {
                                        kotlinx.coroutines.delay(15_000)
                                        nowTick = java.util.Date()
                                    }
                                }
                                val scheduledDate = remember(scheduledAt) { parseApiDate(scheduledAt) }
                                val isDue = scheduledDate == null || !scheduledDate.after(nowTick)
                                var payBusy by remember { mutableStateOf(false) }
                                var payError by remember { mutableStateOf<String?>(null) }
                                if (!isDue) {
                                    Text(
                                        LocalizationManager.tr(
                                            "Please wait until your scheduled payment time before sending payment.",
                                            "Fadlan sug ilaa waqtiga lacag-bixinta ee la qorsheeyay ka hor inta aadan diri lacagta.",
                                        ),
                                        color = Color.Gray,
                                        fontSize = 12.sp,
                                    )
                                    Spacer(Modifier.height(8.dp))
                                }
                                if (payError != null) {
                                    Text(payError!!, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                                    Spacer(Modifier.height(6.dp))
                                }
                                Button(
                                    onClick = {
                                        payBusy = true
                                        payError = null
                                        scope.launch {
                                            try {
                                                val wallet = ApiClient.service.getPaymentWallets().body()
                                                    ?.firstOrNull { it.name == order.paymentMethod }
                                                val dialIntent = wallet?.let { PaymentDialUtil.resolveDialIntent(it, order.amount) }
                                                if (dialIntent != null) {
                                                    context.startActivity(dialIntent)
                                                } else {
                                                    payError = LocalizationManager.tr(
                                                        "Couldn't find your payment number. Please try again.",
                                                        "Lama helin lambarka lacag-bixinta. Fadlan isku day mar kale.",
                                                    )
                                                }
                                            } catch (e: Exception) {
                                                payError = LocalizationManager.tr(
                                                    "Couldn't start payment. Please try again.",
                                                    "Lacag-bixinta lama bilaabi karin. Fadlan isku day mar kale.",
                                                )
                                            }
                                            payBusy = false
                                        }
                                    },
                                    enabled = isDue && !payBusy,
                                    colors = ButtonDefaults.buttonColors(containerColor = SchedulePurple),
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Text(LocalizationManager.tr("Pay Now", "Hadda Bixi"))
                                }
                                Spacer(Modifier.height(10.dp))
                            }
                            if (scheduleActionError != null) {
                                Text(scheduleActionError!!, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                                Spacer(Modifier.height(6.dp))
                            }
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                OutlinedButton(
                                    onClick = {
                                        editDate = LocalDate.now()
                                        editTime = LocalTime.now()
                                        showDatePicker = true
                                    },
                                    enabled = !scheduleActionBusy,
                                    modifier = Modifier.weight(1f),
                                ) {
                                    Icon(Icons.Filled.Edit, contentDescription = null, modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(6.dp))
                                    Text(LocalizationManager.tr("Edit", "Wax ka beddel"))
                                }
                                OutlinedButton(
                                    onClick = {
                                        scheduleActionBusy = true
                                        scheduleActionError = null
                                        scope.launch {
                                            try {
                                                val response = ApiClient.service.requestCancellation(order.id)
                                                if (response.isSuccessful) {
                                                    response.body()?.let { order = it }
                                                    scheduleActionMessage = LocalizationManager.tr(
                                                        "Cancellation requested — awaiting Super Admin review.",
                                                        "Waa la codsaday joojinta — waxay sugeysaa dib u eegis Super Admin.",
                                                    )
                                                } else {
                                                    scheduleActionError = LocalizationManager.tr(
                                                        "Couldn't submit cancellation. Please try again.",
                                                        "Waa suurtagal in joojintu maqan tahay. Fadlan isku day mar kale.",
                                                    )
                                                }
                                            } catch (e: Exception) {
                                                scheduleActionError = LocalizationManager.tr(
                                                    "Couldn't submit cancellation. Please try again.",
                                                    "Waa suurtagal in joojintu maqan tahay. Fadlan isku day mar kale.",
                                                )
                                            }
                                            scheduleActionBusy = false
                                        }
                                    },
                                    enabled = !scheduleActionBusy,
                                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                                    modifier = Modifier.weight(1f),
                                ) {
                                    Text(LocalizationManager.tr("Request Cancellation", "Codso Joojinta"))
                                }
                            }
                            if (scheduleActionMessage != null) {
                                Spacer(Modifier.height(6.dp))
                                Text(scheduleActionMessage!!, color = DalabIndigo, fontSize = 12.sp)
                            }
                        } else if (cancellationRequestedAt != null) {
                            Spacer(Modifier.height(8.dp))
                            val (label, color) = when (order.cancellationDecision) {
                                "approved" -> LocalizationManager.tr(
                                    "Cancellation approved — this order was reversed.",
                                    "Joojinta waa la aqbalay — dalabkan waa la celiyay.",
                                ) to Color(0xFFDC2626)
                                "rejected" -> LocalizationManager.tr(
                                    "Cancellation rejected — the recharge will proceed as scheduled.",
                                    "Joojinta waa la diiday — dib-u-shubidu waxay socon doontaa sida la qorsheeyay.",
                                ) to Color(0xFF16A34A)
                                else -> LocalizationManager.tr(
                                    "Cancellation requested — awaiting Super Admin review.",
                                    "Waa la codsaday joojinta — waxay sugeysaa dib u eegis Super Admin.",
                                ) to Color(0xFFB8860B)
                            }
                            Text(label, color = color, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                        }
                    }
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

    if (showDatePicker) {
        ScheduleDatePickerDialog(
            initialDate = editDate,
            onDismiss = { showDatePicker = false },
            onDatePicked = { picked ->
                editDate = picked
                showDatePicker = false
                showTimePicker = true
            },
        )
    }

    if (showTimePicker) {
        ScheduleTimePickerDialog(
            initialTime = editTime,
            onDismiss = { showTimePicker = false },
            onTimePicked = { picked ->
                editTime = picked
                showTimePicker = false
                val date = editDate
                if (date != null) {
                    val instant = LocalDateTime.of(date, picked).atZone(ZoneId.systemDefault()).toInstant()
                    scheduleActionBusy = true
                    scheduleActionError = null
                    scope.launch {
                        try {
                            val response = ApiClient.service.updateSchedule(order.id, UpdateScheduleRequest(instant.toString()))
                            if (response.isSuccessful) {
                                response.body()?.let { order = it }
                            } else {
                                scheduleActionError = LocalizationManager.tr(
                                    "Couldn't update the schedule. Please try again.",
                                    "Ma suurtagalin in la cusboonaysiiyo qorshaha. Fadlan isku day mar kale.",
                                )
                            }
                        } catch (e: Exception) {
                            scheduleActionError = LocalizationManager.tr(
                                "Couldn't update the schedule. Please try again.",
                                "Ma suurtagalin in la cusboonaysiiyo qorshaha. Fadlan isku day mar kale.",
                            )
                        }
                        scheduleActionBusy = false
                    }
                }
            },
        )
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
