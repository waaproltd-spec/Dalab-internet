package com.dalab.internet.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Event
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.R
import com.dalab.internet.data.TransactionHistoryEntry
import com.dalab.internet.network.ApiClient
import com.dalab.internet.ui.theme.DalabBlue
import com.dalab.internet.ui.theme.DalabDangerRed
import com.dalab.internet.ui.theme.DalabInfoBlue
import com.dalab.internet.ui.theme.DalabOutline
import com.dalab.internet.ui.theme.DalabSoftBlue
import com.dalab.internet.ui.theme.DalabSuccessGreen
import com.dalab.internet.ui.theme.DalabSurfaceTint
import com.dalab.internet.ui.theme.DalabWarningAmber
import com.dalab.internet.ui.theme.DalabWhite
import com.dalab.internet.util.parseApiDate
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

private val TxMuted = DalabBlue.copy(alpha = 0.6f)
private val TxBorder = DalabOutline.copy(alpha = 0.55f)

private data class TxRange(val value: String, val label: String)

private val TX_RANGES = listOf(
    TxRange("today", "Today"),
    TxRange("yesterday", "Yesterday"),
    TxRange("1week", "1 Week"),
    TxRange("1month", "1 Month"),
    TxRange("3months", "3 Months"),
    TxRange("6months", "6 Months"),
    TxRange("1year", "1 Year"),
)

private data class TxProvider(val id: String, val label: String)

private val TX_PROVIDERS = listOf(
    TxProvider("all", "All"),
    TxProvider("hormuud", "Hormuud"),
    TxProvider("somtel", "Somtel"),
    TxProvider("somnet", "Somnet"),
    TxProvider("amtel", "Amtel"),
)

private data class TxStatus(val label: String, val color: Color, val icon: ImageVector)

private fun txStatus(tx: TransactionHistoryEntry): TxStatus = when {
    tx.status == "completed" && tx.reversedAt != null -> TxStatus("Reversed", DalabWarningAmber, Icons.Filled.Replay)
    tx.status == "completed" -> TxStatus("Successful", DalabSuccessGreen, Icons.Filled.CheckCircle)
    tx.status == "failed" -> TxStatus("Failed", DalabDangerRed, Icons.Filled.Error)
    tx.status == "cancelled" -> TxStatus("Cancelled", TxMuted, Icons.Filled.Cancel)
    tx.status == "in_progress" -> TxStatus("Processing", DalabInfoBlue, Icons.Filled.Schedule)
    else -> TxStatus("Pending", DalabWarningAmber, Icons.Filled.Schedule)
}

/** 252612345678 / +252612345678 / 612345678 -> 0612345678; anything else as is. */
private fun localNumber(raw: String?): String {
    if (raw.isNullOrBlank()) return "—"
    val digits = raw.filter { it.isDigit() }
    return when {
        digits.length == 12 && digits.startsWith("252") -> "0" + digits.substring(3)
        digits.length == 9 -> "0$digits"
        else -> raw
    }
}

private fun usd(v: Double) = "$" + String.format(Locale.US, "%.2f", v)
private fun txDate(raw: String?): String = parseApiDate(raw)?.let { SimpleDateFormat("MMM d, yyyy", Locale.US).format(it) } ?: "—"
private fun txTime(raw: String?): String = parseApiDate(raw)?.let { SimpleDateFormat("h:mm a", Locale.US).format(it) } ?: "—"

/** The Agent App "Transaction History": this agent's orders from
 * GET /agent/transactions/history, filtered by date (a range or one day from
 * the calendar), provider and a search -- all three together, on the server.
 * Tapping a card opens [TransactionDetailsScreen]. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TransactionHistoryScreen(onBack: () -> Unit) {
    var range by remember { mutableStateOf("today") }
    var pickedDay by remember { mutableStateOf<Long?>(null) } // UTC midnight millis from the date picker
    var provider by remember { mutableStateOf("all") }
    var search by remember { mutableStateOf("") }
    var transactions by remember { mutableStateOf<List<TransactionHistoryEntry>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var showCalendar by remember { mutableStateOf(false) }
    var opened by remember { mutableStateOf<TransactionHistoryEntry?>(null) }

    val dayParam = pickedDay?.let {
        SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(it))
    }

    LaunchedEffect(range, dayParam, provider, search) {
        // Typing waits a moment so each keystroke isn't its own request.
        if (search.isNotEmpty()) delay(350)
        loading = true
        try {
            val response = ApiClient.service.getTransactionHistory(
                range = if (dayParam == null) range else null,
                date = dayParam,
                companyId = provider,
                search = search.trim().ifEmpty { null },
            )
            if (response.isSuccessful) {
                transactions = response.body().orEmpty()
                error = null
            } else {
                error = "Couldn't load transactions. Please try again."
            }
        } catch (_: Exception) {
            error = "Couldn't load transactions. Check your connection."
        }
        loading = false
    }

    val tx = opened
    if (tx != null) {
        BackHandler { opened = null }
        TransactionDetailsScreen(tx, onBack = { opened = null })
        return
    }

    if (showCalendar) {
        val state = rememberDatePickerState(initialSelectedDateMillis = pickedDay ?: System.currentTimeMillis())
        DatePickerDialog(
            onDismissRequest = { showCalendar = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { pickedDay = it }
                    showCalendar = false
                }) { Text("Show", color = DalabSuccessGreen, fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton(onClick = { showCalendar = false }) { Text("Cancel", color = TxMuted) } },
        ) {
            DatePicker(state = state)
        }
    }

    val periodLabel = pickedDay?.let {
        SimpleDateFormat("MMM d, yyyy", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(it))
    } ?: TX_RANGES.first { it.value == range }.label

    Column(Modifier.fillMaxSize().background(DalabWhite)) {
        // Header + filters on a soft brand wash.
        Column(
            Modifier
                .fillMaxWidth()
                .background(Brush.verticalGradient(listOf(DalabSoftBlue.copy(alpha = 0.45f), DalabSurfaceTint)))
                .statusBarsPadding()
                .padding(bottom = 10.dp),
        ) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                RoundIconButton(Icons.Filled.ArrowBack, "Back", onBack)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("Transaction History", color = DalabBlue, fontSize = 24.sp, fontWeight = FontWeight.Black, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("Customer transactions and payments", color = TxMuted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Spacer(Modifier.width(8.dp))
                RoundIconButton(Icons.Filled.CalendarMonth, "Pick a day", { showCalendar = true }, highlighted = pickedDay != null)
            }
            LazyRow(contentPadding = PaddingValues(horizontal = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(TX_RANGES, key = { it.value }) { r ->
                    FilterPill(r.label, selected = pickedDay == null && r.value == range) {
                        pickedDay = null
                        range = r.value
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            LazyRow(contentPadding = PaddingValues(horizontal = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(TX_PROVIDERS, key = { it.id }) { p ->
                    FilterPill(p.label, selected = p.id == provider, logo = if (p.id == "all") null else logoResFor(p.id)) { provider = p.id }
                }
            }
        }

        OutlinedTextField(
            value = search,
            onValueChange = { search = it },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
            placeholder = { Text("Search by name, number or reference...", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null, tint = TxMuted) },
            trailingIcon = {
                if (search.isNotEmpty()) {
                    IconButton(onClick = { search = "" }) { Icon(Icons.Filled.Close, contentDescription = "Clear search", tint = TxMuted) }
                }
            },
            singleLine = true,
            shape = RoundedCornerShape(16.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = DalabSuccessGreen,
                unfocusedBorderColor = TxBorder,
                focusedContainerColor = DalabWhite,
                unfocusedContainerColor = DalabWhite,
                cursorColor = DalabSuccessGreen,
            ),
        )

        Box(Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 14.dp, end = 14.dp, bottom = 24.dp)) {
                item {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(bottom = 10.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(DalabSurfaceTint)
                            .padding(horizontal = 14.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(periodLabel, color = DalabBlue, fontWeight = FontWeight.Bold, fontSize = 16.sp, modifier = Modifier.weight(1f))
                        Text(
                            "${transactions.size} Transaction" + if (transactions.size == 1) "" else "s",
                            color = TxMuted,
                            fontSize = 13.sp,
                        )
                    }
                }
                if (loading) item { LinearProgressIndicator(Modifier.fillMaxWidth().padding(bottom = 8.dp), color = DalabSuccessGreen) }
                error?.let { msg -> item { Text(msg, color = DalabDangerRed, fontSize = 14.sp, modifier = Modifier.padding(vertical = 8.dp)) } }
                if (!loading && error == null && transactions.isEmpty()) {
                    item {
                        Text(
                            if (search.isBlank()) "No transactions in this period." else "No transactions match \"${search.trim()}\".",
                            color = TxMuted,
                            fontSize = 14.sp,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 40.dp),
                        )
                    }
                }
                items(transactions, key = { it.orderId }) { t ->
                    TransactionCard(t, onClick = { opened = t })
                    Spacer(Modifier.height(10.dp))
                }
            }
        }
    }
}

@Composable
private fun RoundIconButton(icon: ImageVector, description: String, onClick: () -> Unit, highlighted: Boolean = false) {
    Box(
        Modifier
            .size(48.dp)
            .shadow(3.dp, CircleShape)
            .clip(CircleShape)
            .background(if (highlighted) DalabSuccessGreen else DalabWhite)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = description, tint = if (highlighted) DalabWhite else DalabBlue)
    }
}

@Composable
private fun FilterPill(label: String, selected: Boolean, logo: Int? = null, onClick: () -> Unit) {
    Surface(
        color = if (selected) DalabSuccessGreen else DalabWhite,
        shape = RoundedCornerShape(22.dp),
        border = if (selected) null else BorderStroke(1.dp, TxBorder),
        shadowElevation = if (selected) 2.dp else 0.dp,
        modifier = Modifier.clip(RoundedCornerShape(22.dp)).clickable(onClick = onClick),
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (logo != null) {
                Image(
                    painter = painterResource(logo),
                    contentDescription = null,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.size(22.dp).clip(CircleShape).background(DalabWhite),
                )
                Spacer(Modifier.width(8.dp))
            }
            Text(label, color = if (selected) DalabWhite else DalabBlue, fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium, fontSize = 14.sp)
        }
    }
}

@Composable
private fun CompanyBadge(companyId: String, size: androidx.compose.ui.unit.Dp) {
    val res = logoResFor(companyId)
    Box(
        Modifier.size(size).shadow(1.dp, CircleShape).clip(CircleShape).background(DalabWhite),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = painterResource(res),
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize().padding(if (res == R.drawable.dalab_logo) 4.dp else 6.dp).clip(CircleShape),
        )
    }
}

@Composable
private fun TransactionCard(t: TransactionHistoryEntry, onClick: () -> Unit) {
    val status = txStatus(t)
    Surface(
        color = DalabWhite,
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, TxBorder),
        shadowElevation = 2.dp,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).clickable(onClick = onClick),
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CompanyBadge(t.companyId, 50.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        t.customerName ?: localNumber(t.customerPhone),
                        color = DalabBlue,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Description, contentDescription = null, tint = TxMuted, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(4.dp))
                        Text(t.orderId, color = TxMuted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                Spacer(Modifier.width(8.dp))
                Text(usd(t.amount), color = DalabSuccessGreen, fontSize = 20.sp, fontWeight = FontWeight.Black)
                Icon(Icons.Filled.ChevronRight, contentDescription = "Open details", tint = DalabSuccessGreen)
            }
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NumberChip(Icons.Filled.Payments, DalabSuccessGreen, "Payment Number", localNumber(t.paymentNumber), Modifier.weight(1f))
                NumberChip(Icons.Filled.Wifi, DalabInfoBlue, "Internet Destination", localNumber(t.destinationNumber), Modifier.weight(1f))
            }
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Event, contentDescription = null, tint = TxMuted, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(4.dp))
                Text(txDate(t.createdAt), color = TxMuted, fontSize = 13.sp, maxLines = 1)
                Spacer(Modifier.width(10.dp))
                Icon(Icons.Filled.AccessTime, contentDescription = null, tint = TxMuted, modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(4.dp))
                Text(txTime(t.createdAt), color = TxMuted, fontSize = 13.sp, maxLines = 1, modifier = Modifier.weight(1f))
                StatusPill(status)
            }
        }
    }
}

@Composable
private fun NumberChip(icon: ImageVector, tint: Color, label: String, number: String, modifier: Modifier) {
    Row(
        modifier.clip(RoundedCornerShape(12.dp)).background(DalabSurfaceTint).padding(horizontal = 8.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(28.dp).background(tint.copy(alpha = 0.14f), CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
        }
        Spacer(Modifier.width(6.dp))
        Column(Modifier.weight(1f)) {
            Text(label, color = TxMuted, fontSize = 10.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(number, color = DalabBlue, fontSize = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun StatusPill(status: TxStatus) {
    Row(
        Modifier.clip(RoundedCornerShape(14.dp)).background(status.color.copy(alpha = 0.12f)).padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(status.icon, contentDescription = null, tint = status.color, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(5.dp))
        Text(status.label, color = status.color, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}

/** One transaction in full -- read-only, from the row already loaded. */
@Composable
private fun TransactionDetailsScreen(t: TransactionHistoryEntry, onBack: () -> Unit) {
    val status = txStatus(t)
    LazyColumn(Modifier.fillMaxSize().background(DalabWhite), contentPadding = PaddingValues(bottom = 24.dp)) {
        item {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(DalabSoftBlue.copy(alpha = 0.45f), DalabSurfaceTint)))
                    .statusBarsPadding()
                    .padding(horizontal = 14.dp, vertical = 12.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RoundIconButton(Icons.Filled.ArrowBack, "Back", onBack)
                    Spacer(Modifier.width(12.dp))
                    Text("Transaction Details", color = DalabBlue, fontSize = 22.sp, fontWeight = FontWeight.Black, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Spacer(Modifier.height(18.dp))
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    CompanyBadge(t.companyId, 64.dp)
                    Spacer(Modifier.height(10.dp))
                    Text(usd(t.amount), color = DalabSuccessGreen, fontSize = 34.sp, fontWeight = FontWeight.Black)
                    Spacer(Modifier.height(6.dp))
                    StatusPill(status)
                    Spacer(Modifier.height(8.dp))
                }
            }
        }
        item { DetailsSection("Customer", listOf("Name" to (t.customerName ?: "—"), "Reference" to t.orderId)) }
        item {
            DetailsSection(
                "Numbers",
                listOf("Payment Number" to localNumber(t.paymentNumber), "Internet Destination" to localNumber(t.destinationNumber)),
            )
        }
        item {
            DetailsSection(
                "Package",
                listOfNotNull(
                    "Company" to t.companyName,
                    "Package" to (t.packageName ?: "—"),
                    t.packageValidity?.takeIf { it.isNotBlank() }?.let { "Validity" to it },
                    t.paymentMethod?.takeIf { it.isNotBlank() }?.let { "Payment Method" to it },
                    "Amount" to usd(t.amount),
                ),
            )
        }
        item {
            DetailsSection(
                "Time",
                listOfNotNull(
                    "Date" to txDate(t.createdAt),
                    "Time" to txTime(t.createdAt),
                    t.completedAt?.let { "Completed" to "${txDate(it)} · ${txTime(it)}" },
                    t.reversedAt?.let { "Reversed" to "${txDate(it)} · ${txTime(it)}" },
                    "Status" to status.label,
                ),
            )
        }
    }
}

@Composable
private fun DetailsSection(title: String, rows: List<Pair<String, String>>) {
    Column(Modifier.padding(start = 14.dp, end = 14.dp, top = 14.dp)) {
        Text(title, color = DalabBlue, fontSize = 15.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 4.dp, bottom = 6.dp))
        Surface(
            color = DalabWhite,
            shape = RoundedCornerShape(16.dp),
            border = BorderStroke(1.dp, TxBorder),
            shadowElevation = 1.dp,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column {
                rows.forEachIndexed { i, (label, value) ->
                    if (i > 0) Divider(color = DalabSurfaceTint)
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(label, color = TxMuted, fontSize = 14.sp, modifier = Modifier.weight(1f))
                        Spacer(Modifier.width(10.dp))
                        Text(value, color = DalabBlue, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}
