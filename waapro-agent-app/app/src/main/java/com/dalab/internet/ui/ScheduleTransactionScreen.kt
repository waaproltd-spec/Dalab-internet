package com.dalab.internet.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.data.Order
import com.dalab.internet.data.OrderStatus
import com.dalab.internet.data.ScheduleCompany
import com.dalab.internet.data.ScheduleOrderRequest
import com.dalab.internet.data.SchedulePackage
import com.dalab.internet.network.AgentActionRequest
import com.dalab.internet.network.ApiClient
import com.dalab.internet.ui.i18n.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import retrofit2.Response
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID

/** Scheduled times are always Somalia time, whatever the phone's own zone. */
val MOGADISHU: ZoneId = ZoneId.of("Africa/Mogadishu")
private val DAY_FMT = DateTimeFormatter.ofPattern("dd/MM/yyyy")
private val TIME_FMT = DateTimeFormatter.ofPattern("h:mm a")

/** "17/11/2026 10:45 AM" in Mogadishu time; the raw text if it can't be read. */
fun scheduleTimeText(iso: String?): String {
    val t = try { iso?.let { Instant.parse(it) } } catch (_: Exception) { null } ?: return iso ?: ""
    val z = t.atZone(MOGADISHU)
    return "${z.format(DAY_FMT)} ${z.format(TIME_FMT)}"
}

/** What a scheduled order is doing now, in one short label, with its colours. */
data class ScheduleState(val label: String, val ink: Color, val bg: Color)

fun scheduleState(o: Order, now: Instant = Instant.now()): ScheduleState {
    val at = try { o.scheduledAt?.let { Instant.parse(it) } } catch (_: Exception) { null }
    val due = at == null || !at.isAfter(now)
    return when (o.status) {
        OrderStatus.PENDING -> when {
            o.scheduledPaidAt != null -> ScheduleState("Paid · waiting for its time", Color(0xFF137A3A), Color(0xFFE6F6EC))
            due -> ScheduleState("Time reached · waiting for payment", Color(0xFFB45309), Color(0xFFFFEDD5))
            else -> ScheduleState("Waiting for payment", Color(0xFF8A6200), Color(0xFFFFF4D6))
        }
        OrderStatus.IN_PROGRESS -> ScheduleState("Sending now", Color(0xFF1D4ED8), Color(0xFFDBEAFE))
        OrderStatus.COMPLETED -> ScheduleState("Sent", Color(0xFF137A3A), Color(0xFFE6F6EC))
        OrderStatus.FAILED -> ScheduleState("Failed", Color(0xFFDC2626), Color(0xFFFDE2E2))
        OrderStatus.CANCELLED -> ScheduleState("Cancelled", Color(0xFF5B6475), Color(0xFFE5E7EB))
    }
}

/** The server's own error text ({"error": "..."}), if any. */
private fun serverError(response: Response<*>): String? = try {
    response.errorBody()?.string()?.let { org.json.JSONObject(it).optString("error").takeIf { s -> s.isNotBlank() } }
} catch (_: Exception) {
    null
}

/**
 * Schedule Transaction: the agent registers a customer, picks a package and
 * the time it should be sent. Prepaid orders are sent automatically at that
 * time; pay-at-execution orders wait for the customer's payment.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScheduleTransactionScreen(onBack: () -> Unit) {
    var showForm by remember { mutableStateOf(false) }
    var orders by remember { mutableStateOf<List<Order>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }
    var cancelling by remember { mutableStateOf<Order?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(reload) {
        while (true) {
            try {
                val r = ApiClient.service.getScheduledOrders()
                if (r.isSuccessful) { orders = r.body().orEmpty(); error = null } else error = serverError(r) ?: "Could not load scheduled orders (${r.code()})."
            } catch (_: Exception) {
                error = "No connection — showing the last list."
            }
            loaded = true
            delay(20_000L)
        }
    }

    fun act(call: suspend () -> Response<*>, done: String) {
        busy = true
        error = null
        scope.launch {
            try {
                val r = call()
                if (r.isSuccessful) { info = done; cancelling = null; reload++ } else error = serverError(r) ?: "That didn't work (${r.code()})."
            } catch (_: Exception) {
                error = "That didn't work. Check your connection."
            }
            busy = false
        }
    }

    if (showForm) {
        ScheduleForm(
            onCancel = { showForm = false },
            onScheduled = { o ->
                showForm = false
                info = "Scheduled for ${scheduleTimeText(o.scheduledAt)}."
                reload++
            },
        )
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Schedule Transaction", fontWeight = FontWeight.Bold) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { info = null; showForm = true },
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("New schedule") },
                containerColor = WaaproNavy,
                contentColor = Color.White,
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            info?.let { Text(it, color = Color(0xFF137A3A), fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) }
            error?.let { Text(it, color = Color(0xFFDC2626), fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
            when {
                !loaded -> Text("Loading…", color = WaaproMuted, modifier = Modifier.padding(16.dp))
                orders.isEmpty() -> Text("No scheduled transactions yet. Tap New schedule to register a customer.", color = WaaproMuted, modifier = Modifier.padding(16.dp))
                else -> LazyColumn(
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(orders, key = { it.id }) { o ->
                        ScheduledRow(
                            o,
                            busy = busy,
                            onSendNow = { act({ ApiClient.service.runScheduledOrderNow(o.id) }, "${o.id} is being sent now.") },
                            onCancel = { cancelling = o },
                        )
                    }
                }
            }
        }
    }

    cancelling?.let { o ->
        var reason by remember(o.id) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { if (!busy) cancelling = null },
            title = { Text("Cancel ${o.id}?") },
            text = {
                Column {
                    Text("It will not be sent. Enter the reason.")
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(value = reason, onValueChange = { reason = it.take(300) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !busy && reason.trim().length >= 3,
                    onClick = { act({ ApiClient.service.cancelOrder(o.id, AgentActionRequest(reason.trim())) }, "${o.id} cancelled.") },
                ) { Text("Cancel order") }
            },
            dismissButton = { TextButton(enabled = !busy, onClick = { cancelling = null }) { Text("Keep") } },
        )
    }
}

@Composable
private fun ScheduledRow(o: Order, busy: Boolean, onSendNow: () -> Unit, onCancel: () -> Unit) {
    val state = scheduleState(o)
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().border(1.dp, WaaproBorder, RoundedCornerShape(14.dp)),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(o.customerName ?: o.senderPhone ?: o.id, fontWeight = FontWeight.Bold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text("$${"%.2f".format(o.amount)}", fontWeight = FontWeight.ExtraBold, color = Color(0xFF137A3A))
            }
            Text("${o.packageName} · ${o.companyName}", fontSize = 13.sp)
            Text("Pays from ${o.senderPhone ?: "-"}  →  sends to ${o.receiverPhone ?: "-"}", fontSize = 12.sp, color = WaaproMuted)
            Text("${scheduleTimeText(o.scheduledAt)} (Mogadishu) · ${o.id}", fontSize = 12.sp, color = WaaproMuted)
            o.scheduleNote?.let { Text("Note: $it", fontSize = 12.sp, color = WaaproMuted, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(shape = RoundedCornerShape(50), color = state.bg) {
                    Text(state.label, color = state.ink, fontWeight = FontWeight.Bold, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
                }
                Spacer(Modifier.weight(1f))
                if (o.status == OrderStatus.PENDING) {
                    val future = try { o.scheduledAt?.let { Instant.parse(it).isAfter(Instant.now()) } ?: false } catch (_: Exception) { false }
                    if (future) TextButton(enabled = !busy, onClick = onSendNow) { Text("Send now") }
                    TextButton(enabled = !busy, onClick = onCancel) { Text("Cancel", color = Color(0xFFDC2626)) }
                }
            }
        }
    }
}

/** The registration form, laid out like the web "Schedule Transaction" dialog. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScheduleForm(onCancel: () -> Unit, onScheduled: (Order) -> Unit) {
    var companies by remember { mutableStateOf<List<ScheduleCompany>>(emptyList()) }
    var optionsError by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var recipient by remember { mutableStateOf("") }
    var recipientEdited by remember { mutableStateOf(false) }
    var company by remember { mutableStateOf<ScheduleCompany?>(null) }
    var pkg by remember { mutableStateOf<SchedulePackage?>(null) }
    val start = remember { ZonedDateTime.now(MOGADISHU).plusMinutes(15).withSecond(0).withNano(0) }
    var day by remember { mutableStateOf(start.toLocalDate()) }
    var time by remember { mutableStateOf(start.toLocalTime()) }
    var mode by remember { mutableStateOf("pay_at_execution") }
    var note by remember { mutableStateOf("") }
    var pickDay by remember { mutableStateOf(false) }
    var pickTime by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val requestId = remember { UUID.randomUUID().toString() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        try {
            val r = ApiClient.service.getScheduleOptions()
            if (r.isSuccessful) {
                companies = r.body()?.companies.orEmpty()
                company = companies.firstOrNull()
            } else optionsError = serverError(r) ?: "Could not load networks (${r.code()})."
        } catch (_: Exception) {
            optionsError = "No connection — could not load networks and packages."
        }
    }

    val whenZoned = ZonedDateTime.of(day, time, MOGADISHU)
    val ready = name.trim().length >= 2 && phone.trim().length >= 7 && company != null && pkg != null && !saving

    fun submit() {
        val c = company ?: return
        val p = pkg ?: return
        saving = true
        error = null
        scope.launch {
            try {
                val r = ApiClient.service.createScheduledOrder(
                    ScheduleOrderRequest(
                        customerName = name.trim(),
                        customerPhone = phone.trim(),
                        companyId = c.id,
                        packageId = p.id,
                        receiverPhone = recipient.trim().ifEmpty { phone.trim() },
                        scheduledAt = whenZoned.withZoneSameInstant(ZoneOffset.UTC).toInstant().toString(),
                        paymentMode = mode,
                        note = note.trim().ifEmpty { null },
                        clientRequestId = requestId,
                    ),
                )
                val body = r.body()
                if (r.isSuccessful && body != null) onScheduled(body) else error = serverError(r) ?: "Could not schedule (${r.code()})."
            } catch (_: Exception) {
                error = "Could not reach the server. Check your connection and try again."
            }
            saving = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Schedule Transaction", fontWeight = FontWeight.Bold) },
                navigationIcon = { IconButton(onClick = onCancel) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } },
            )
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Register the customer, pick a package, and set when it should execute.", color = WaaproMuted, fontSize = 13.sp)
            optionsError?.let { Text(it, color = Color(0xFFDC2626), fontSize = 13.sp) }

            Field("Customer Full Name") {
                OutlinedTextField(value = name, onValueChange = { name = it.take(120) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
            Field("Customer Phone Number", hint = "The number the payment for this schedule will arrive from.") {
                OutlinedTextField(
                    value = phone,
                    onValueChange = { v ->
                        phone = v.filter { it.isDigit() || it == '+' }.take(15)
                        if (!recipientEdited) recipient = phone
                    },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.weight(1f)) {
                    Field("Network") {
                        Picker(
                            text = company?.name ?: "Choose",
                            items = companies.map { it.name + if (it.status == "offline") " (offline)" else "" },
                            onPick = { i -> company = companies[i]; pkg = null },
                        )
                    }
                }
                Box(Modifier.weight(1f)) {
                    Field("Package") {
                        val list = company?.packages.orEmpty()
                        Picker(
                            text = pkg?.let { "${it.name} — $${"%.2f".format(it.price)}" } ?: "Choose",
                            items = list.map { "${it.name} — $${"%.2f".format(it.price)}" },
                            onPick = { i -> pkg = list[i] },
                        )
                    }
                }
            }
            Field("Recipient Phone Number", hint = "The number that receives the internet.") {
                OutlinedTextField(
                    value = recipient,
                    onValueChange = { v -> recipient = v.filter { it.isDigit() || it == '+' }.take(15); recipientEdited = true },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.weight(1f)) { Field("Scheduled Date") { PickerBox(day.format(DAY_FMT)) { pickDay = true } } }
                Box(Modifier.weight(1f)) { Field("Scheduled Time") { PickerBox(time.format(TIME_FMT)) { pickTime = true } } }
            }
            Text("Africa/Mogadishu time (UTC+3).", color = WaaproMuted, fontSize = 12.sp)

            Text("Payment Mode", fontWeight = FontWeight.Bold)
            ModeOption(
                selected = mode == "prepaid",
                title = "Prepaid",
                body = "You have received the payment now. The system waits and executes automatically at the scheduled time.",
            ) { mode = "prepaid" }
            ModeOption(
                selected = mode == "pay_at_execution",
                title = "Pay at Execution",
                body = "No payment yet. At the scheduled time the system checks for the customer's payment — if it hasn't arrived, it waits until it does.",
            ) { mode = "pay_at_execution" }

            Field("Internal Note (optional)") {
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it.take(500) },
                    placeholder = { Text("Visible only to agents and admins") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth().border(1.dp, WaaproBorder, RoundedCornerShape(14.dp))) {
                Column(Modifier.padding(14.dp)) {
                    Text("Review", color = WaaproMuted, fontSize = 12.sp)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("${pkg?.name ?: "—"} · ${company?.name ?: "—"}", fontWeight = FontWeight.Bold, fontSize = 16.sp, modifier = Modifier.weight(1f))
                        pkg?.let { Text("$${"%.2f".format(it.price)}", fontWeight = FontWeight.ExtraBold, color = Color(0xFF137A3A), fontSize = 16.sp) }
                    }
                    Text("Executes ${day.format(DateTimeFormatter.ISO_LOCAL_DATE)} at ${time.format(DateTimeFormatter.ofPattern("HH:mm"))} (Mogadishu time)", color = WaaproMuted, fontSize = 12.sp)
                }
            }
            error?.let { Text(it, color = Color(0xFFDC2626), fontWeight = FontWeight.Bold) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
                OutlinedButton(onClick = onCancel, enabled = !saving, modifier = Modifier.weight(1f)) { Text("Cancel") }
                Button(
                    onClick = { submit() },
                    enabled = ready,
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF3F6B21)),
                    modifier = Modifier.weight(1.6f),
                ) { Text(if (saving) "Scheduling…" else "Schedule Transaction") }
            }
        }
    }

    if (pickDay) {
        val utcMillis = day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val state = rememberDatePickerState(initialSelectedDateMillis = utcMillis)
        DatePickerDialog(
            onDismissRequest = { pickDay = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { day = Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() }
                    pickDay = false
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { pickDay = false }) { Text("Cancel") } },
        ) { DatePicker(state = state) }
    }
    if (pickTime) {
        val state = rememberTimePickerState(initialHour = time.hour, initialMinute = time.minute, is24Hour = false)
        AlertDialog(
            onDismissRequest = { pickTime = false },
            title = { Text("Scheduled time (Mogadishu)") },
            text = { TimePicker(state = state) },
            confirmButton = { TextButton(onClick = { time = LocalTime.of(state.hour, state.minute); pickTime = false }) { Text("OK") } },
            dismissButton = { TextButton(onClick = { pickTime = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun Field(label: String, hint: String? = null, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, fontWeight = FontWeight.Bold, fontSize = 14.sp)
        content()
        hint?.let { Text(it, color = WaaproMuted, fontSize = 12.sp) }
    }
}

@Composable
private fun PickerBox(text: String, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(6.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().height(56.dp).border(1.dp, WaaproBorder, RoundedCornerShape(6.dp)).clickable(onClick = onClick),
    ) {
        Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
        }
    }
}

@Composable
private fun Picker(text: String, items: List<String>, onPick: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        PickerBox(text) { if (items.isNotEmpty()) open = true }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            items.forEachIndexed { i, label ->
                DropdownMenuItem(text = { Text(label) }, onClick = { open = false; onPick(i) })
            }
        }
    }
}

@Composable
private fun ModeOption(selected: Boolean, title: String, body: String, onSelect: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().selectable(selected = selected, onClick = onSelect).padding(vertical = 2.dp),
        verticalAlignment = Alignment.Top,
    ) {
        RadioButton(selected = selected, onClick = onSelect)
        Spacer(Modifier.width(4.dp))
        Column(Modifier.padding(top = 12.dp)) {
            Text(title, fontWeight = FontWeight.Bold)
            Text(body, color = WaaproMuted, fontSize = 13.sp)
        }
    }
}
