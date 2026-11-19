package com.dalab.internet.ui

import androidx.compose.foundation.border
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Person
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.data.RegisterCustomerRequest
import com.dalab.internet.data.RegisteredCustomer
import com.dalab.internet.data.RegisteredCustomerDetail
import com.dalab.internet.data.RegistrationIssue
import com.dalab.internet.data.RegistrationNetwork
import com.dalab.internet.data.RegistrationOrder
import com.dalab.internet.network.ApiClient
import com.dalab.internet.ui.i18n.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import retrofit2.Response

// ---------------- Helpers ----------------

private fun regServerError(response: Response<*>): String? = try {
    response.errorBody()?.string()?.let { org.json.JSONObject(it).optString("error").takeIf { s -> s.isNotBlank() } }
} catch (_: Exception) {
    null
}

private fun local9(p: String?): String = p?.filter { it.isDigit() }?.takeLast(9)?.ifEmpty { null } ?: "-"
private fun regMoney(n: Double?): String = "$" + "%.2f".format(n ?: 0.0)

private data class RegBadge(val label: String, val ink: Color, val bg: Color)

private fun deliveryBadge(state: String?) = when (state) {
    "delivered" -> RegBadge("Delivered", Color(0xFF137A3A), Color(0xFFE6F6EC))
    "sending" -> RegBadge("Sending", Color(0xFF1D4ED8), Color(0xFFDBEAFE))
    "failed" -> RegBadge("Failed", Color(0xFFDC2626), Color(0xFFFDE2E2))
    "cancelled" -> RegBadge("Cancelled", Color(0xFF5B6475), Color(0xFFE5E7EB))
    else -> RegBadge("Waiting", Color(0xFF8A6200), Color(0xFFFFF4D6))
}

private fun paymentBadge(state: String?) = when (state) {
    "paid" -> RegBadge("Paid", Color(0xFF137A3A), Color(0xFFE6F6EC))
    "payment_failed" -> RegBadge("Payment failed", Color(0xFFDC2626), Color(0xFFFDE2E2))
    else -> RegBadge("Awaiting payment", Color(0xFF8A6200), Color(0xFFFFF4D6))
}

@Composable
private fun BadgeChip(b: RegBadge) {
    Surface(shape = RoundedCornerShape(50), color = b.bg) {
        Text(b.label, color = b.ink, fontWeight = FontWeight.Bold, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
    }
}

@Composable
private fun RegCard(onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, WaaproBorder, RoundedCornerShape(14.dp))
            .let { if (onClick != null) it.clickable(onClick = onClick) else it },
    ) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { content() } }
}

@Composable
private fun OrderRow(o: RegistrationOrder, showCustomer: Boolean) {
    RegCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (showCustomer) (o.customerName ?: o.id) else (o.packageName ?: o.id),
                fontWeight = FontWeight.Bold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Text(regMoney(o.amount), fontWeight = FontWeight.ExtraBold, color = Color(0xFF137A3A))
        }
        Text("${o.packageName ?: "-"} · ${o.companyName ?: "-"}", fontSize = 13.sp)
        Text("To ${local9(o.receiverPhone)} · ${scheduleTimeText(o.createdAt)}", fontSize = 12.sp, color = WaaproMuted)
        Text("Order ${o.id} · Transaction ${o.transactionRef ?: "-"}", fontSize = 12.sp, color = WaaproMuted, fontFamily = FontFamily.Monospace)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            BadgeChip(paymentBadge(o.paymentState))
            BadgeChip(deliveryBadge(o.deliveryState))
        }
    }
}

@Composable
private fun IssueRow(i: RegistrationIssue, showCustomer: Boolean) {
    RegCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (showCustomer) (i.customerName ?: "Customer") else "Payment not processed", fontWeight = FontWeight.Bold, fontSize = 15.sp, modifier = Modifier.weight(1f))
            Text(regMoney(i.amount), fontWeight = FontWeight.ExtraBold, color = Color(0xFFDC2626))
        }
        Text(i.reason ?: "", fontSize = 13.sp, color = Color(0xFFDC2626))
        Text("From ${local9(i.senderPhone)} · Transaction ${i.transactionRef ?: "-"}", fontSize = 12.sp, color = WaaproMuted)
        Text(scheduleTimeText(i.createdAt), fontSize = 12.sp, color = WaaproMuted)
        if (i.resolvedAt != null) BadgeChip(RegBadge("Resolved by admin", Color(0xFF137A3A), Color(0xFFE6F6EC)))
        else Text("No internet was sent. The admin has been told.", fontSize = 12.sp, color = WaaproMuted)
    }
}

// ---------------- Design pieces ----------------

private fun hexColor(hex: String?, fallback: Color): Color =
    try { hex?.let { Color(android.graphics.Color.parseColor(it)) } ?: fallback } catch (_: Exception) { fallback }

/** The brand header: back, title, and the agent's figures at a glance. */
@Composable
private fun RegHeader(onBack: () -> Unit, customers: Int, delivered: Int, problems: Int) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(WaaproHeaderBrush, RoundedCornerShape(bottomStart = 26.dp, bottomEnd = 26.dp))
            .padding(start = 8.dp, end = 16.dp, top = 10.dp, bottom = 18.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
            Column {
                Text("Register Customer", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp)
                Text("They pay without the app; the internet is sent once the payment is verified", color = Color.White.copy(alpha = 0.8f), fontSize = 12.sp)
            }
        }
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(start = 8.dp)) {
            StatPill("Customers", customers.toString(), Modifier.weight(1f))
            StatPill("Delivered", delivered.toString(), Modifier.weight(1f))
            StatPill("Problems", problems.toString(), Modifier.weight(1f), alert = problems > 0)
        }
    }
}

@Composable
private fun StatPill(label: String, value: String, modifier: Modifier, alert: Boolean = false) {
    Surface(shape = RoundedCornerShape(16.dp), color = if (alert) Color(0xFFDC2626).copy(alpha = 0.85f) else Color.White.copy(alpha = 0.14f), modifier = modifier) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(value, color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp)
            Text(label, color = Color.White.copy(alpha = 0.85f), fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun RegEmpty(title: String, hint: String) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.fillMaxWidth().padding(top = 48.dp, start = 32.dp, end = 32.dp),
    ) {
        BrandIconTile(Icons.Filled.PersonAdd, size = 64.dp)
        Spacer(Modifier.height(14.dp))
        Text(title, fontWeight = FontWeight.Bold, fontSize = 17.sp)
        Spacer(Modifier.height(4.dp))
        Text(hint, color = WaaproMuted, fontSize = 13.sp)
    }
}

@Composable
private fun NumberLine(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, number: String, tint: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier.size(30.dp).clip(CircleShape).background(tint.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center,
        ) { Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(17.dp)) }
        Spacer(Modifier.width(10.dp))
        Text(label, color = WaaproMuted, fontSize = 13.sp, modifier = Modifier.width(78.dp))
        Text(number, fontWeight = FontWeight.Bold, fontSize = 15.sp, letterSpacing = 0.5.sp)
    }
}

@Composable
private fun Figure(value: String, label: String, modifier: Modifier) {
    Column(modifier) {
        Text(value, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp)
        Text(label, color = WaaproMuted, fontSize = 11.sp)
    }
}

/** A network to pick: its colour, its name, a tick when chosen; greyed when offline. */
@Composable
private fun NetworkCard(n: RegistrationNetwork, selected: Boolean, modifier: Modifier, onPick: () -> Unit) {
    val offline = n.status == "offline"
    val net = hexColor(n.colorHex, WaaproBlue)
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = if (selected) net.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surface,
        modifier = modifier
            .height(64.dp)
            .border(if (selected) 2.dp else 1.dp, if (selected) net else WaaproBorder, RoundedCornerShape(16.dp))
            .clickable(enabled = !offline, onClick = onPick),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 14.dp)) {
            Box(Modifier.size(14.dp).clip(CircleShape).background(if (offline) WaaproBorder else net))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(n.name, fontWeight = FontWeight.Bold, fontSize = 15.sp, color = if (offline) WaaproMuted else Color.Unspecified, maxLines = 1)
                if (offline) Text("Offline", color = Color(0xFFDC2626), fontSize = 11.sp)
            }
            if (selected) Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = net, modifier = Modifier.size(20.dp))
        }
    }
}

/** One registered customer: who, the two numbers, the network, figures, Edit / Remove. */
@Composable
private fun CustomerCard(c: RegisteredCustomer, onOpen: () -> Unit, onEdit: () -> Unit, onRemove: () -> Unit) {
    val net = hexColor(c.companyColor, WaaproBlue)
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 2.dp,
        modifier = Modifier.fillMaxWidth().border(1.dp, WaaproBorder, RoundedCornerShape(20.dp)).clickable(onClick = onOpen),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier.size(46.dp).clip(CircleShape).background(net.copy(alpha = 0.15f)),
                    contentAlignment = Alignment.Center,
                ) { Text((c.name?.trim()?.firstOrNull() ?: '?').uppercase(), color = net, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp) }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(c.name ?: "-", fontWeight = FontWeight.ExtraBold, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("Registered ${scheduleTimeText(c.registeredByAgentAt)}", color = WaaproMuted, fontSize = 11.5.sp, maxLines = 1)
                }
                Surface(shape = RoundedCornerShape(50), color = net) {
                    Text(c.companyName ?: "", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp))
                }
            }
            Spacer(Modifier.height(14.dp))
            NumberLine(Icons.Filled.Payments, "Pays from", local9(c.senderNumber), WaaproNavy)
            Spacer(Modifier.height(8.dp))
            NumberLine(Icons.Filled.Wifi, "Internet to", local9(c.receiverNumber), net)
            if ((c.openPaymentIssues ?: 0) > 0) {
                Spacer(Modifier.height(10.dp))
                BadgeChip(RegBadge("${c.openPaymentIssues} payment problem(s)", Color(0xFFDC2626), Color(0xFFFDE2E2)))
            }
            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = WaaproBorder)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Figure("${c.orders ?: 0}", "orders", Modifier.weight(1f))
                Figure("${c.delivered ?: 0}", "delivered", Modifier.weight(1f))
                Figure(regMoney(c.totalPaid), "paid", Modifier.weight(1f))
                TextButton(onClick = onEdit) {
                    Icon(Icons.Filled.Edit, contentDescription = null, modifier = Modifier.size(18.dp), tint = WaaproBlue)
                    Spacer(Modifier.width(4.dp))
                    Text("Edit", color = WaaproBlue, fontWeight = FontWeight.Bold)
                }
                TextButton(onClick = onRemove) {
                    Icon(Icons.Filled.Delete, contentDescription = null, modifier = Modifier.size(18.dp), tint = Color(0xFFDC2626))
                    Spacer(Modifier.width(4.dp))
                    Text("Remove", color = Color(0xFFDC2626), fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

// ---------------- Screen ----------------

/**
 * Register Customer: the agent registers a customer with name, payment
 * number, internet number and network. The customer pays (no app needed);
 * the system verifies the payment and only then sends the internet. Tabs:
 * My Customers, History (every order), Payment Problems.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentRegistrationScreen(onBack: () -> Unit) {
    var showForm by remember { mutableStateOf(false) }
    var openId by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<RegisteredCustomer?>(null) }
    var removing by remember { mutableStateOf<RegisteredCustomer?>(null) }
    var removeBusy by remember { mutableStateOf(false) }
    val listScope = rememberCoroutineScope()
    var tab by remember { mutableIntStateOf(0) }
    var search by remember { mutableStateOf("") }
    var customers by remember { mutableStateOf<List<RegisteredCustomer>>(emptyList()) }
    var history by remember { mutableStateOf<List<RegistrationOrder>>(emptyList()) }
    var issues by remember { mutableStateOf<List<RegistrationIssue>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    // The three lists load at the same time; the customers show as soon as
    // they arrive, and no request may keep the screen waiting for more than
    // 20 seconds (a slow or dropped connection shows an error with Retry).
    LaunchedEffect(reload) {
        while (true) {
            coroutineScope {
                val h = async { withTimeoutOrNull(20_000L) { runCatching { ApiClient.service.getRegisteredTransactions() }.getOrNull() } }
                val i = async { withTimeoutOrNull(20_000L) { runCatching { ApiClient.service.getRegisteredPaymentIssues() }.getOrNull() } }
                val c = withTimeoutOrNull(20_000L) { runCatching { ApiClient.service.getRegisteredCustomers() } }
                when {
                    c == null -> error = "The server is taking too long to answer."
                    c.isFailure -> error = "No connection — could not refresh the list."
                    else -> {
                        val r = c.getOrThrow()
                        when {
                            r.code() == 404 -> error = "This system is not updated for customer registration yet."
                            r.isSuccessful -> { customers = r.body().orEmpty(); error = null }
                            else -> error = regServerError(r) ?: "Could not load your customers (${r.code()})."
                        }
                    }
                }
                loaded = true
                h.await()?.let { if (it.isSuccessful) history = it.body().orEmpty() }
                i.await()?.let { if (it.isSuccessful) issues = it.body().orEmpty() }
            }
            delay(20_000L)
        }
    }

    editing?.let { e ->
        RegisterCustomerForm(
            existing = e,
            onCancel = { editing = null },
            onRegistered = { c ->
                editing = null
                info = "${c.name ?: "Customer"} updated."
                reload++
            },
        )
        return
    }
    if (showForm) {
        RegisterCustomerForm(
            onCancel = { showForm = false },
            onRegistered = { c ->
                showForm = false
                info = if (c.created == false) "${c.name ?: "Customer"} updated." else "${c.name ?: "Customer"} registered."
                reload++
                openId = c.id
            },
        )
        return
    }
    openId?.let { id ->
        RegisteredCustomerDetailScreen(id, onBack = { openId = null; reload++ })
        return
    }

    val shown = remember(customers, search) {
        val q = search.trim().lowercase()
        if (q.isEmpty()) customers
        else customers.filter { listOfNotNull(it.name, it.senderNumber, it.receiverNumber).any { s -> s.lowercase().contains(q) } }
    }
    val openIssues = issues.count { it.resolvedAt == null }

    val deliveredTotal = customers.sumOf { it.delivered ?: 0 }
    Scaffold(
        topBar = {
            RegHeader(
                onBack = onBack,
                customers = customers.size,
                delivered = deliveredTotal,
                problems = openIssues,
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { info = null; showForm = true },
                icon = { Icon(Icons.Filled.PersonAdd, contentDescription = null) },
                text = { Text("Register customer", fontWeight = FontWeight.Bold) },
                containerColor = WaaproNavy,
                contentColor = Color.White,
                shape = RoundedCornerShape(18.dp),
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            TabRow(selectedTabIndex = tab, containerColor = MaterialTheme.colorScheme.surface, contentColor = WaaproNavy) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Customers", fontWeight = FontWeight.Bold) })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("History", fontWeight = FontWeight.Bold) })
                Tab(selected = tab == 2, onClick = { tab = 2 }, text = { Text(if (openIssues > 0) "Problems ($openIssues)" else "Problems", fontWeight = FontWeight.Bold) })
            }
            info?.let { Text(it, color = Color(0xFF137A3A), fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) }
            error?.let {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 16.dp, end = 8.dp, top = 4.dp)) {
                    Text(it, color = Color(0xFFDC2626), fontSize = 13.sp, modifier = Modifier.weight(1f))
                    TextButton(onClick = { error = null; reload++ }) { Text("Retry", fontWeight = FontWeight.Bold) }
                }
            }
            val pad = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp)
            when {
                !loaded -> Text("Loading…", color = WaaproMuted, modifier = Modifier.padding(16.dp))
                tab == 0 -> {
                    OutlinedTextField(
                        value = search, onValueChange = { search = it }, singleLine = true,
                        placeholder = { Text("Search name or number") },
                        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null, tint = WaaproMuted) },
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    )
                    if (shown.isEmpty()) RegEmpty(
                        if (customers.isEmpty()) "No customers yet" else "No customer matches",
                        if (customers.isEmpty()) "Tap Register customer to add the first one." else "Try another name or number.",
                    )
                    else LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(shown, key = { it.id }) { c ->
                            CustomerCard(
                                c,
                                onOpen = { openId = c.id },
                                onEdit = { info = null; editing = c },
                                onRemove = { info = null; removing = c },
                            )
                        }
                    }
                }
                tab == 1 -> if (history.isEmpty()) RegEmpty("No orders yet", "When a customer pays, the order appears here.")
                else LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(history, key = { it.id }) { OrderRow(it, showCustomer = true) }
                }
                else -> if (issues.isEmpty()) RegEmpty("No payment problems", "Payments that can't be processed show here.")
                else LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(issues, key = { it.id }) { IssueRow(it, showCustomer = true) }
                }
            }
        }
    }

    removing?.let { c ->
        AlertDialog(
            onDismissRequest = { if (!removeBusy) removing = null },
            title = { Text("Remove ${c.name ?: "this customer"}?") },
            text = { Text("Payments from ${local9(c.senderNumber)} will no longer send internet automatically. The customer's past orders and payments are kept.") },
            confirmButton = {
                TextButton(
                    enabled = !removeBusy,
                    onClick = {
                        removeBusy = true
                        listScope.launch {
                            try {
                                val r = ApiClient.service.removeRegisteredCustomer(c.id)
                                if (r.isSuccessful) {
                                    customers = customers.filter { it.id != c.id }
                                    info = "${c.name ?: "Customer"} removed."
                                    error = null
                                    reload++
                                } else error = regServerError(r) ?: "Could not remove (${r.code()})."
                            } catch (_: Exception) {
                                error = "Could not remove. Check your connection."
                            }
                            removeBusy = false
                            removing = null
                        }
                    },
                ) { Text("Remove", color = Color(0xFFDC2626)) }
            },
            dismissButton = { TextButton(enabled = !removeBusy, onClick = { removing = null }) { Text("Keep") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RegisterCustomerForm(existing: RegisteredCustomer? = null, onCancel: () -> Unit, onRegistered: (RegisteredCustomer) -> Unit) {
    var networks by remember { mutableStateOf<List<RegistrationNetwork>>(emptyList()) }
    var optionsError by remember { mutableStateOf<String?>(null) }
    // Editing: the form starts from the customer's current details.
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var sender by remember { mutableStateOf(existing?.senderNumber?.let { local9(it) } ?: "") }
    var receiver by remember { mutableStateOf(existing?.receiverNumber?.let { local9(it) } ?: "") }
    var receiverEdited by remember { mutableStateOf(existing != null) }
    var network by remember { mutableStateOf<RegistrationNetwork?>(null) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        try {
            val r = ApiClient.service.getRegistrationOptions()
            if (r.isSuccessful) {
                networks = r.body()?.networks.orEmpty()
                network = networks.firstOrNull { it.id == existing?.companyId } ?: networks.firstOrNull { it.status != "offline" }
            } else optionsError = if (r.code() == 404) "This system is not updated for customer registration yet." else regServerError(r) ?: "Could not load networks (${r.code()})."
        } catch (_: Exception) {
            optionsError = "No connection — could not load the networks."
        }
    }

    val ready = name.trim().length >= 2 && sender.filter { it.isDigit() }.length >= 9 && receiver.filter { it.isDigit() }.length >= 9 && network != null && !saving

    fun submit() {
        val n = network ?: return
        saving = true
        error = null
        scope.launch {
            try {
                val body = RegisterCustomerRequest(name.trim(), sender.trim(), receiver.trim(), n.id)
                val r = if (existing != null) ApiClient.service.updateRegisteredCustomer(existing.id, body) else ApiClient.service.registerCustomer(body)
                if (r.isSuccessful) r.body()?.let(onRegistered) ?: run { error = "Registered, but the answer was empty. Refresh the list." }
                else error = regServerError(r) ?: (if (existing != null) "Could not save (${r.code()})." else "Could not register (${r.code()}).")
            } catch (_: Exception) {
                error = "Could not register. Check your connection."
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
                    .padding(start = 8.dp, end = 16.dp, top = 12.dp, bottom = 16.dp),
            ) {
                IconButton(onClick = onCancel) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                Text(
                    if (existing != null) "Edit customer" else "Register customer",
                    color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp,
                )
            }
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            val fieldShape = RoundedCornerShape(16.dp)
            OutlinedTextField(
                value = name, onValueChange = { name = it.take(80) }, singleLine = true,
                label = { Text("Customer name") },
                leadingIcon = { Icon(Icons.Filled.Person, contentDescription = null, tint = WaaproNavy) },
                shape = fieldShape,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = sender,
                onValueChange = { v ->
                    sender = v.filter { it.isDigit() }.take(12)
                    if (!receiverEdited) receiver = sender
                },
                singleLine = true,
                label = { Text("Payment sender number") },
                leadingIcon = { Icon(Icons.Filled.Payments, contentDescription = null, tint = WaaproNavy) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                shape = fieldShape,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = receiver,
                onValueChange = { v -> receiver = v.filter { it.isDigit() }.take(12); receiverEdited = true },
                singleLine = true,
                label = { Text("Internet receiver number") },
                leadingIcon = { Icon(Icons.Filled.Wifi, contentDescription = null, tint = WaaproNavy) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                shape = fieldShape,
                modifier = Modifier.fillMaxWidth(),
            )
            Text("Network", fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, modifier = Modifier.padding(top = 4.dp))
            optionsError?.let { Text(it, color = Color(0xFFDC2626), fontSize = 13.sp) }
            networks.chunked(2).forEach { pair ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    pair.forEach { n -> NetworkCard(n, selected = network?.id == n.id, modifier = Modifier.weight(1f)) { network = n } }
                    if (pair.size == 1) Spacer(Modifier.weight(1f))
                }
            }
            error?.let { Text(it, color = Color(0xFFDC2626), fontSize = 13.sp) }
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(
                    onClick = onCancel, enabled = !saving, shape = RoundedCornerShape(18.dp),
                    modifier = Modifier.weight(1f).height(54.dp),
                ) { Text("Cancel", fontWeight = FontWeight.Bold) }
                Button(
                    onClick = { submit() }, enabled = ready, shape = RoundedCornerShape(18.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = WaaproNavy, contentColor = Color.White),
                    modifier = Modifier.weight(1f).height(54.dp),
                ) { Text(if (saving) "Saving…" else if (existing != null) "Save" else "Register", fontWeight = FontWeight.Bold) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RegisteredCustomerDetailScreen(id: String, onBack: () -> Unit) {
    var detail by remember { mutableStateOf<RegisteredCustomerDetail?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(id) {
        while (true) {
            try {
                val r = ApiClient.service.getRegisteredCustomer(id)
                if (r.isSuccessful) { detail = r.body(); error = null } else error = regServerError(r) ?: "Could not load (${r.code()})."
            } catch (_: Exception) {
                error = "No connection."
            }
            delay(15_000L)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(detail?.name ?: "Customer", fontWeight = FontWeight.Bold) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } },
            )
        },
    ) { padding ->
        val d = detail
        LazyColumn(
            Modifier.padding(padding).fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            error?.let { e -> item { Text(e, color = Color(0xFFDC2626), fontSize = 13.sp) } }
            if (d == null) {
                item { Text("Loading…", color = WaaproMuted) }
                return@LazyColumn
            }
            item {
                RegCard {
                    Text("Payment number: ${local9(d.senderNumber)}", fontWeight = FontWeight.SemiBold)
                    Text("Internet number: ${local9(d.receiverNumber)}", fontWeight = FontWeight.SemiBold)
                    Text("Network: ${d.companyName ?: "-"}", fontWeight = FontWeight.SemiBold)
                    Text("Registered ${scheduleTimeText(d.registeredByAgentAt)} · ${regMoney(d.totalPaid)} paid", fontSize = 12.sp, color = WaaproMuted)
                }
            }
            val issues = d.paymentIssues.orEmpty()
            if (issues.isNotEmpty()) {
                item { Text("Payment problems", fontWeight = FontWeight.Bold, fontSize = 16.sp) }
                items(issues, key = { "i-" + it.id }) { IssueRow(it, showCustomer = false) }
            }
            item { Text("Orders", fontWeight = FontWeight.Bold, fontSize = 16.sp) }
            val orders = d.orders.orEmpty()
            if (orders.isEmpty()) item { Text("No orders yet. When the customer pays, the order appears here.", color = WaaproMuted) }
            else items(orders, key = { it.id }) { OrderRow(it, showCustomer = false) }
        }
    }
}
