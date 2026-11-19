package com.dalab.internet.ui

import androidx.compose.foundation.border
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
    var tab by remember { mutableIntStateOf(0) }
    var search by remember { mutableStateOf("") }
    var customers by remember { mutableStateOf<List<RegisteredCustomer>>(emptyList()) }
    var history by remember { mutableStateOf<List<RegistrationOrder>>(emptyList()) }
    var issues by remember { mutableStateOf<List<RegistrationIssue>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        while (true) {
            try {
                val c = ApiClient.service.getRegisteredCustomers()
                val h = ApiClient.service.getRegisteredTransactions()
                val i = ApiClient.service.getRegisteredPaymentIssues()
                when {
                    c.code() == 404 -> error = "This system is not updated for customer registration yet."
                    c.isSuccessful -> {
                        customers = c.body().orEmpty()
                        if (h.isSuccessful) history = h.body().orEmpty()
                        if (i.isSuccessful) issues = i.body().orEmpty()
                        error = null
                    }
                    else -> error = regServerError(c) ?: "Could not load your customers (${c.code()})."
                }
            } catch (_: Exception) {
                error = "No connection — showing the last list."
            }
            loaded = true
            delay(20_000L)
        }
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

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Register Customer", fontWeight = FontWeight.Bold) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { info = null; showForm = true },
                icon = { Icon(Icons.Filled.PersonAdd, contentDescription = null) },
                text = { Text("Register customer") },
                containerColor = WaaproNavy,
                contentColor = Color.White,
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            TabRow(selectedTabIndex = tab) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Customers (${customers.size})") })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("History") })
                Tab(selected = tab == 2, onClick = { tab = 2 }, text = { Text(if (openIssues > 0) "Problems ($openIssues)" else "Problems") })
            }
            info?.let { Text(it, color = Color(0xFF137A3A), fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) }
            error?.let { Text(it, color = Color(0xFFDC2626), fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
            val pad = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp)
            when {
                !loaded -> Text("Loading…", color = WaaproMuted, modifier = Modifier.padding(16.dp))
                tab == 0 -> {
                    OutlinedTextField(
                        value = search, onValueChange = { search = it }, singleLine = true,
                        label = { Text("Search name or number") },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                    if (shown.isEmpty()) Text(
                        if (customers.isEmpty()) "No customers yet. Tap Register customer." else "No customer matches.",
                        color = WaaproMuted, modifier = Modifier.padding(16.dp),
                    )
                    else LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        items(shown, key = { it.id }) { c ->
                            RegCard(onClick = { openId = c.id }) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(c.name ?: "-", fontWeight = FontWeight.Bold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                    Text(c.companyName ?: "", fontWeight = FontWeight.Bold, color = WaaproNavy, fontSize = 13.sp)
                                }
                                Text("Pays from ${local9(c.senderNumber)}  →  internet to ${local9(c.receiverNumber)}", fontSize = 13.sp)
                                Text("${c.orders ?: 0} orders · ${c.delivered ?: 0} delivered · ${regMoney(c.totalPaid)} paid", fontSize = 12.sp, color = WaaproMuted)
                                if ((c.openPaymentIssues ?: 0) > 0) BadgeChip(RegBadge("${c.openPaymentIssues} payment problem(s)", Color(0xFFDC2626), Color(0xFFFDE2E2)))
                            }
                        }
                    }
                }
                tab == 1 -> if (history.isEmpty()) Text("No orders yet.", color = WaaproMuted, modifier = Modifier.padding(16.dp))
                else LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(history, key = { it.id }) { OrderRow(it, showCustomer = true) }
                }
                else -> if (issues.isEmpty()) Text("No payment problems.", color = WaaproMuted, modifier = Modifier.padding(16.dp))
                else LazyColumn(contentPadding = pad, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(issues, key = { it.id }) { IssueRow(it, showCustomer = true) }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RegisterCustomerForm(onCancel: () -> Unit, onRegistered: (RegisteredCustomer) -> Unit) {
    var networks by remember { mutableStateOf<List<RegistrationNetwork>>(emptyList()) }
    var optionsError by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf("") }
    var sender by remember { mutableStateOf("") }
    var receiver by remember { mutableStateOf("") }
    var receiverEdited by remember { mutableStateOf(false) }
    var network by remember { mutableStateOf<RegistrationNetwork?>(null) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        try {
            val r = ApiClient.service.getRegistrationOptions()
            if (r.isSuccessful) {
                networks = r.body()?.networks.orEmpty()
                network = networks.firstOrNull { it.status != "offline" }
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
                val r = ApiClient.service.registerCustomer(RegisterCustomerRequest(name.trim(), sender.trim(), receiver.trim(), n.id))
                if (r.isSuccessful) r.body()?.let(onRegistered) ?: run { error = "Registered, but the answer was empty. Refresh the list." }
                else error = regServerError(r) ?: "Could not register (${r.code()})."
            } catch (_: Exception) {
                error = "Could not register. Check your connection."
            }
            saving = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Register customer", fontWeight = FontWeight.Bold) },
                navigationIcon = { IconButton(onClick = onCancel) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } },
            )
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("The customer does not need the app. They send the money from the payment number; once the payment is verified, the internet goes to the internet number.", fontSize = 13.sp, color = WaaproMuted)
            OutlinedTextField(
                value = name, onValueChange = { name = it.take(80) }, singleLine = true,
                label = { Text("Customer name") }, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = sender,
                onValueChange = { v ->
                    sender = v.filter { it.isDigit() }.take(12)
                    if (!receiverEdited) receiver = sender
                },
                singleLine = true,
                label = { Text("Payment sender number") },
                supportingText = { Text("The number the customer pays from") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = receiver,
                onValueChange = { v -> receiver = v.filter { it.isDigit() }.take(12); receiverEdited = true },
                singleLine = true,
                label = { Text("Internet receiver number") },
                supportingText = { Text("The number that gets the internet (must be on the network below)") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                modifier = Modifier.fillMaxWidth(),
            )
            Text("Network", fontWeight = FontWeight.Bold)
            optionsError?.let { Text(it, color = Color(0xFFDC2626), fontSize = 13.sp) }
            networks.forEach { n ->
                val offline = n.status == "offline"
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().selectable(selected = network?.id == n.id, enabled = !offline, onClick = { network = n }),
                ) {
                    RadioButton(selected = network?.id == n.id, onClick = { network = n }, enabled = !offline)
                    Text(n.name, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    if (offline) Text("Offline", color = Color(0xFFDC2626), fontSize = 12.sp)
                }
            }
            error?.let { Text(it, color = Color(0xFFDC2626), fontSize = 13.sp) }
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = onCancel, enabled = !saving, modifier = Modifier.weight(1f).height(52.dp)) { Text("Cancel") }
                Button(
                    onClick = { submit() }, enabled = ready,
                    colors = ButtonDefaults.buttonColors(containerColor = WaaproNavy, contentColor = Color.White),
                    modifier = Modifier.weight(1f).height(52.dp),
                ) { Text(if (saving) "Saving…" else "Register") }
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
