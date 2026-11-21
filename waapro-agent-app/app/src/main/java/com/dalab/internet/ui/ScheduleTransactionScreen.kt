package com.dalab.internet.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material.icons.filled.CellTower
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.EditNote
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
            val waiting = orders.count { it.status == OrderStatus.PENDING || it.status == OrderStatus.IN_PROGRESS }
            val sent = orders.count { it.status == OrderStatus.COMPLETED }
            val failed = orders.count { it.status == OrderStatus.FAILED }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(WaaproHeaderBrush, RoundedCornerShape(bottomStart = 26.dp, bottomEnd = 26.dp))
                    .padding(start = 8.dp, end = 16.dp, top = 10.dp, bottom = 18.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                    Text("Schedule Transaction", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp)
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(start = 8.dp)) {
                    SchedulePill("Waiting", waiting.toString(), Modifier.weight(1f))
                    SchedulePill("Sent", sent.toString(), Modifier.weight(1f))
                    SchedulePill("Failed", failed.toString(), Modifier.weight(1f), alert = failed > 0)
                }
            }
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { info = null; showForm = true },
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("New schedule", fontWeight = FontWeight.Bold) },
                containerColor = WaaproNavy,
                contentColor = Color.White,
                shape = RoundedCornerShape(18.dp),
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            info?.let { Text(it, color = Color(0xFF137A3A), fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) }
            error?.let { Text(it, color = Color(0xFFDC2626), fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
            when {
                !loaded -> Text("Loading…", color = WaaproMuted, modifier = Modifier.padding(16.dp))
                orders.isEmpty() -> Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.fillMaxWidth().padding(top = 48.dp, start = 32.dp, end = 32.dp),
                ) {
                    BrandIconTile(Icons.Filled.Schedule, size = 64.dp)
                    Spacer(Modifier.height(14.dp))
                    Text("No scheduled transactions yet", fontWeight = FontWeight.Bold, fontSize = 17.sp)
                    Spacer(Modifier.height(4.dp))
                    Text("Tap New schedule to add the first one.", color = WaaproMuted, fontSize = 13.sp)
                }
                else -> LazyColumn(
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 96.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
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
private fun SchedulePill(label: String, value: String, modifier: Modifier, alert: Boolean = false) {
    Surface(shape = RoundedCornerShape(16.dp), color = if (alert) Color(0xFFDC2626).copy(alpha = 0.85f) else Color.White.copy(alpha = 0.14f), modifier = modifier) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(value, color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp)
            Text(label, color = Color.White.copy(alpha = 0.85f), fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun ScheduleNumberLine(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, number: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(28.dp).clip(CircleShape).background(WaaproNavy.copy(alpha = 0.10f)), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(16.dp))
        }
        Spacer(Modifier.width(10.dp))
        Text(label, color = WaaproMuted, fontSize = 13.sp, modifier = Modifier.width(78.dp))
        Text(number, fontWeight = FontWeight.Bold, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** One scheduled order: who, price, package, the two numbers, when, its state, Send now / Cancel. */
@Composable
private fun ScheduledRow(o: Order, busy: Boolean, onSendNow: () -> Unit, onCancel: () -> Unit) {
    val state = scheduleState(o)
    val local9 = { p: String? -> p?.filter { it.isDigit() }?.takeLast(9)?.ifEmpty { null } ?: "-" }
    // A name, else the number it pays from (a "name" that is just a number shows as 9 digits).
    val who = o.customerName?.takeIf { it.isNotBlank() && it.count { c -> c.isDigit() } < 7 } ?: local9(o.senderPhone)
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 2.dp,
        modifier = Modifier.fillMaxWidth().border(1.dp, WaaproBorder, RoundedCornerShape(20.dp)),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(44.dp).clip(CircleShape).background(WaaproNavy.copy(alpha = 0.10f)), contentAlignment = Alignment.Center) {
                    Text((who.firstOrNull() ?: '?').uppercase(), color = WaaproNavy, fontWeight = FontWeight.ExtraBold, fontSize = 19.sp)
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(who, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${o.packageName} · ${o.companyName}", color = WaaproMuted, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text("$${"%.2f".format(o.amount)}", fontWeight = FontWeight.ExtraBold, color = Color(0xFF137A3A), fontSize = 18.sp)
            }
            Spacer(Modifier.height(12.dp))
            ScheduleNumberLine(Icons.Filled.Payments, "Pays from", local9(o.senderPhone))
            Spacer(Modifier.height(6.dp))
            ScheduleNumberLine(Icons.Filled.Wifi, "Internet to", local9(o.receiverPhone))
            Spacer(Modifier.height(6.dp))
            ScheduleNumberLine(Icons.Filled.Schedule, "When", scheduleTimeText(o.scheduledAt))
            o.scheduleNote?.let { Text("Note: $it", fontSize = 12.sp, color = WaaproMuted, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp)) }
            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = WaaproBorder)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(shape = RoundedCornerShape(50), color = state.bg) {
                    Text(state.label, color = state.ink, fontWeight = FontWeight.Bold, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
                }
                Spacer(Modifier.width(8.dp))
                Text(o.id, color = WaaproMuted, fontSize = 11.sp, modifier = Modifier.weight(1f), maxLines = 1)
                if (o.status == OrderStatus.PENDING) {
                    val future = try { o.scheduledAt?.let { Instant.parse(it).isAfter(Instant.now()) } ?: false } catch (_: Exception) { false }
                    if (future) TextButton(enabled = !busy, onClick = onSendNow) { Text("Send now", fontWeight = FontWeight.Bold) }
                    TextButton(enabled = !busy, onClick = onCancel) { Text("Cancel", color = Color(0xFFDC2626), fontWeight = FontWeight.Bold) }
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
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(WaaproHeaderBrush, RoundedCornerShape(bottomStart = 26.dp, bottomEnd = 26.dp))
                    .padding(start = 8.dp, end = 16.dp, top = 10.dp, bottom = 14.dp),
            ) {
                IconButton(onClick = onCancel) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                Text("Schedule Transaction", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 21.sp)
            }
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            optionsError?.let { Text(it, color = Color(0xFFDC2626), fontSize = 13.sp) }
            val shape = RoundedCornerShape(14.dp)
            OutlinedTextField(
                value = name, onValueChange = { name = it.take(120) }, singleLine = true,
                label = { Text("Customer name") },
                leadingIcon = { Icon(Icons.Filled.Person, contentDescription = null, tint = WaaproNavy) },
                shape = shape, modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = phone,
                    onValueChange = { v ->
                        phone = v.filter { it.isDigit() || it == '+' }.take(15)
                        if (!recipientEdited) recipient = phone
                    },
                    singleLine = true,
                    label = { Text("Pays from") },
                    leadingIcon = { Icon(Icons.Filled.Payments, contentDescription = null, tint = WaaproNavy) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    shape = shape, modifier = Modifier.weight(1f),
                )
                OutlinedTextField(
                    value = recipient,
                    onValueChange = { v -> recipient = v.filter { it.isDigit() || it == '+' }.take(15); recipientEdited = true },
                    singleLine = true,
                    label = { Text("Internet to") },
                    leadingIcon = { Icon(Icons.Filled.Wifi, contentDescription = null, tint = WaaproNavy) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    shape = shape, modifier = Modifier.weight(1f),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.weight(1f)) {
                    CompactPicker(
                        label = "Network", icon = Icons.Filled.CellTower,
                        text = company?.name ?: "Choose",
                        items = companies.map { it.name + if (it.status == "offline") " (offline)" else "" },
                    ) { i -> company = companies[i]; pkg = null }
                }
                Box(Modifier.weight(1f)) {
                    val list = company?.packages.orEmpty()
                    CompactPicker(
                        label = "Package", icon = Icons.Filled.Inventory2,
                        text = pkg?.let { "${it.name} · $${"%.2f".format(it.price)}" } ?: "Choose",
                        items = list.map { "${it.name} — $${"%.2f".format(it.price)}" },
                    ) { i -> pkg = list[i] }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.weight(1f)) { CompactBox("Date", Icons.Filled.CalendarMonth, day.format(DAY_FMT)) { pickDay = true } }
                Box(Modifier.weight(1f)) { CompactBox("Time (Mogadishu)", Icons.Filled.AccessTime, time.format(TIME_FMT)) { pickTime = true } }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ModeChip("Prepaid", Icons.Filled.CheckCircle, mode == "prepaid", Modifier.weight(1f)) { mode = "prepaid" }
                ModeChip("Pay at execution", Icons.Filled.Schedule, mode == "pay_at_execution", Modifier.weight(1f)) { mode = "pay_at_execution" }
            }
            OutlinedTextField(
                value = note, onValueChange = { note = it.take(500) }, singleLine = true,
                label = { Text("Note (optional)") },
                leadingIcon = { Icon(Icons.Filled.EditNote, contentDescription = null, tint = WaaproNavy) },
                shape = shape, modifier = Modifier.fillMaxWidth(),
            )
            error?.let { Text(it, color = Color(0xFFDC2626), fontWeight = FontWeight.Bold, fontSize = 13.sp) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 16.dp)) {
                OutlinedButton(onClick = onCancel, enabled = !saving, shape = RoundedCornerShape(18.dp), modifier = Modifier.weight(1f).height(54.dp)) {
                    Text("Cancel", fontWeight = FontWeight.Bold)
                }
                Button(
                    onClick = { submit() },
                    enabled = ready,
                    shape = RoundedCornerShape(18.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = WaaproNavy, contentColor = Color.White),
                    modifier = Modifier.weight(1.6f).height(54.dp),
                ) {
                    Text(
                        if (saving) "Scheduling…" else pkg?.let { "Schedule · $${"%.2f".format(it.price)}" } ?: "Schedule",
                        fontWeight = FontWeight.Bold,
                    )
                }
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

/** A field-like box: small label, icon and value; opens a picker when tapped. */
@Composable
private fun CompactBox(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().height(58.dp).border(1.dp, WaaproBorder, RoundedCornerShape(14.dp)).clickable(onClick = onClick),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 12.dp)) {
            Icon(icon, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(label, color = WaaproMuted, fontSize = 11.sp, maxLines = 1)
                Text(text, fontWeight = FontWeight.Bold, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.Filled.ArrowDropDown, contentDescription = null, tint = WaaproMuted)
        }
    }
}

@Composable
private fun CompactPicker(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    text: String,
    items: List<String>,
    onPick: (Int) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        CompactBox(label, icon, text) { if (items.isNotEmpty()) open = true }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            items.forEachIndexed { i, item -> DropdownMenuItem(text = { Text(item) }, onClick = { open = false; onPick(i) }) }
        }
    }
}

/** One payment mode, side by side with the other: icon and name, outlined when chosen. */
@Composable
private fun ModeChip(title: String, icon: androidx.compose.ui.graphics.vector.ImageVector, selected: Boolean, modifier: Modifier, onSelect: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = if (selected) WaaproNavy.copy(alpha = 0.08f) else MaterialTheme.colorScheme.surface,
        modifier = modifier.height(54.dp)
            .border(if (selected) 2.dp else 1.dp, if (selected) WaaproNavy else WaaproBorder, RoundedCornerShape(14.dp))
            .clickable(onClick = onSelect),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center, modifier = Modifier.padding(horizontal = 8.dp)) {
            Icon(icon, contentDescription = null, tint = if (selected) WaaproNavy else WaaproMuted, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(title, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = if (selected) WaaproNavy else Color.Unspecified, maxLines = 1)
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
