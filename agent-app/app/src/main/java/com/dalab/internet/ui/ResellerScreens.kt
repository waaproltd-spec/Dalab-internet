package com.dalab.internet.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.Storefront
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.auth.ResellerSessionManager
import com.dalab.internet.data.ResellerCompany
import com.dalab.internet.data.ResellerDeposit
import com.dalab.internet.data.ResellerDepositMethod
import com.dalab.internet.data.ResellerMe
import com.dalab.internet.data.ResellerOrder
import com.dalab.internet.data.ResellerWithdrawal
import com.dalab.internet.network.ResellerApiClient
import com.dalab.internet.network.ResellerCreateDepositRequest
import com.dalab.internet.network.ResellerCreateOrderRequest
import com.dalab.internet.network.ResellerCreateWithdrawalRequest
import com.dalab.internet.network.ResellerLoginRequest
import com.dalab.internet.ui.theme.DalabDangerRed
import com.dalab.internet.ui.theme.DalabOutline
import com.dalab.internet.ui.theme.DalabSuccessGreen
import com.dalab.internet.ui.theme.DalabWarningAmber
import com.dalab.internet.util.formatApiDateTime
import com.google.gson.JsonParser
import kotlinx.coroutines.launch
import retrofit2.Response
import java.util.UUID

/**
 * The Agent App's window into the EXISTING Admin Reseller system -- see
 * data/ResellerModels.kt's header comment for the full picture. This file
 * is the whole Reseller section reached from More -> Reseller: a login
 * screen (a reseller's own Reseller ID + PIN, a completely separate
 * identity from this device's agent login) and a dashboard (balance,
 * Orders/Deposits/Withdrawals history, and creating a new one of each) --
 * every read/write here goes straight through the same `/reseller/...`
 * routes admin-backend-ts already exposes and super-admin-app already
 * calls as Admin's own Resellers tab. No new backend route, table, or
 * business rule was added for this -- purely a new client of what already
 * exists.
 */

private enum class ResellerTab { ORDERS, DEPOSITS, WITHDRAWALS }
private enum class ResellerCreateMode { ORDER, DEPOSIT, WITHDRAWAL }

@Composable
fun ResellerScreen(onBack: () -> Unit) {
    var loggedIn by remember { mutableStateOf(ResellerSessionManager.isLoggedIn()) }
    if (loggedIn) {
        ResellerDashboardScreen(onBack = onBack, onLoggedOut = { loggedIn = false })
    } else {
        ResellerLoginScreen(onBack = onBack, onLoginSuccess = { loggedIn = true })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ResellerLoginScreen(onBack: () -> Unit, onLoginSuccess: () -> Unit) {
    var resellerId by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun login() {
        if (resellerId.isBlank() || pin.isBlank()) {
            error = "Enter your Reseller ID and PIN"
            return
        }
        busy = true
        error = null
        scope.launch {
            try {
                val res = ResellerApiClient.service.resellerLogin(ResellerLoginRequest(resellerId.trim(), pin.trim()))
                val body = res.body()
                if (res.isSuccessful && body != null) {
                    ResellerSessionManager.saveSession(body.accessToken, body.refreshToken, body.reseller)
                    onLoginSuccess()
                } else {
                    error = resellerErrorMessage(res, "Invalid ID/PIN. Please contact Admin.")
                }
            } catch (e: Exception) {
                error = "Could not connect. Check your internet connection."
            } finally {
                busy = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Reseller Login") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        ) {
            Spacer(Modifier.height(24.dp))
            Icon(
                Icons.Filled.Storefront,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(56.dp).align(Alignment.CenterHorizontally),
            )
            Spacer(Modifier.height(16.dp))
            Text(
                "Reseller Login",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )
            Text(
                "Log in with the Reseller ID and PIN Admin gave you",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )
            Spacer(Modifier.height(28.dp))
            OutlinedTextField(
                value = resellerId,
                onValueChange = { resellerId = it },
                label = { Text("Reseller ID") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = pin,
                onValueChange = { pin = it },
                label = { Text("PIN") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                modifier = Modifier.fillMaxWidth(),
            )
            if (error != null) {
                Spacer(Modifier.height(10.dp))
                Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(20.dp))
            Button(onClick = ::login, enabled = !busy, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                if (busy) CircularProgressIndicator(modifier = Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
                else Text("Log In")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ResellerDashboardScreen(onBack: () -> Unit, onLoggedOut: () -> Unit) {
    val scope = rememberCoroutineScope()
    var me by remember { mutableStateOf<ResellerMe?>(null) }
    var tab by remember { mutableStateOf(ResellerTab.ORDERS) }
    var createMode by remember { mutableStateOf<ResellerCreateMode?>(null) }

    var orders by remember { mutableStateOf<List<ResellerOrder>>(emptyList()) }
    var deposits by remember { mutableStateOf<List<ResellerDeposit>>(emptyList()) }
    var withdrawals by remember { mutableStateOf<List<ResellerWithdrawal>>(emptyList()) }
    var companies by remember { mutableStateOf<List<ResellerCompany>>(emptyList()) }
    var depositMethods by remember { mutableStateOf<List<ResellerDepositMethod>>(emptyList()) }
    var listLoading by remember { mutableStateOf(true) }

    fun loadMe() {
        scope.launch {
            try {
                val res = ResellerApiClient.service.getResellerMe()
                if (res.isSuccessful && res.body() != null) {
                    me = res.body()
                } else if (res.code() == 401) {
                    ResellerSessionManager.clear()
                    onLoggedOut()
                }
            } catch (_: Exception) {
                // Keep showing the last known balance on a transient failure.
            }
        }
    }

    fun loadTabData() {
        listLoading = true
        scope.launch {
            try {
                when (tab) {
                    ResellerTab.ORDERS -> orders = ResellerApiClient.service.getResellerOrders().body().orEmpty()
                    ResellerTab.DEPOSITS -> deposits = ResellerApiClient.service.getResellerDeposits().body().orEmpty()
                    ResellerTab.WITHDRAWALS -> withdrawals = ResellerApiClient.service.getResellerWithdrawals().body().orEmpty()
                }
            } catch (_: Exception) {
                // Keep showing the last known list on a transient failure.
            }
            listLoading = false
        }
    }

    LaunchedEffect(Unit) {
        loadMe()
        try { companies = ResellerApiClient.service.getResellerCompanies().body().orEmpty() } catch (_: Exception) {}
        try { depositMethods = ResellerApiClient.service.getResellerDepositMethods().body().orEmpty() } catch (_: Exception) {}
    }
    LaunchedEffect(tab) { loadTabData() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(resellerCreateModeTitle(createMode)) },
                navigationIcon = {
                    IconButton(onClick = { if (createMode != null) createMode = null else onBack() }) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (createMode == null) {
                        IconButton(onClick = {
                            ResellerSessionManager.clear()
                            onLoggedOut()
                        }) {
                            Icon(Icons.Filled.ExitToApp, contentDescription = "Log out")
                        }
                    }
                },
            )
        },
        floatingActionButton = {
            if (createMode == null) {
                FloatingActionButton(onClick = {
                    createMode = when (tab) {
                        ResellerTab.ORDERS -> ResellerCreateMode.ORDER
                        ResellerTab.DEPOSITS -> ResellerCreateMode.DEPOSIT
                        ResellerTab.WITHDRAWALS -> ResellerCreateMode.WITHDRAWAL
                    }
                }) { Icon(Icons.Filled.Add, contentDescription = "New") }
            }
        },
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            when (createMode) {
                ResellerCreateMode.ORDER -> ResellerNewOrderForm(
                    companies = companies,
                    onSubmitted = { createMode = null; tab = ResellerTab.ORDERS; loadTabData() },
                )
                ResellerCreateMode.DEPOSIT -> ResellerNewDepositForm(
                    methods = depositMethods,
                    onSubmitted = { createMode = null; tab = ResellerTab.DEPOSITS; loadTabData() },
                )
                ResellerCreateMode.WITHDRAWAL -> ResellerNewWithdrawalForm(
                    companies = companies,
                    onSubmitted = { createMode = null; tab = ResellerTab.WITHDRAWALS; loadTabData() },
                )
                null -> Column(modifier = Modifier.fillMaxSize()) {
                    ResellerBalanceHeader(me = me)
                    TabRow(selectedTabIndex = tab.ordinal) {
                        Tab(selected = tab == ResellerTab.ORDERS, onClick = { tab = ResellerTab.ORDERS }, text = { Text("Orders") })
                        Tab(selected = tab == ResellerTab.DEPOSITS, onClick = { tab = ResellerTab.DEPOSITS }, text = { Text("Deposits") })
                        Tab(selected = tab == ResellerTab.WITHDRAWALS, onClick = { tab = ResellerTab.WITHDRAWALS }, text = { Text("Withdrawals") })
                    }
                    Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                        val isEmpty = when (tab) {
                            ResellerTab.ORDERS -> orders.isEmpty()
                            ResellerTab.DEPOSITS -> deposits.isEmpty()
                            ResellerTab.WITHDRAWALS -> withdrawals.isEmpty()
                        }
                        if (listLoading && isEmpty) {
                            CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                        } else when (tab) {
                            ResellerTab.ORDERS -> ResellerOrdersList(orders)
                            ResellerTab.DEPOSITS -> ResellerDepositsList(deposits)
                            ResellerTab.WITHDRAWALS -> ResellerWithdrawalsList(withdrawals, onChanged = { loadTabData() })
                        }
                    }
                }
            }
        }
    }
}

private fun resellerCreateModeTitle(mode: ResellerCreateMode?): String = when (mode) {
    ResellerCreateMode.ORDER -> "New Order"
    ResellerCreateMode.DEPOSIT -> "New Deposit"
    ResellerCreateMode.WITHDRAWAL -> "New Withdrawal"
    null -> "Reseller"
}

@Composable
private fun ResellerBalanceHeader(me: ResellerMe?) {
    Surface(color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(20.dp)) {
            Text(
                me?.name ?: "Reseller",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            Text(
                me?.resellerLoginId ?: "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            Spacer(Modifier.height(12.dp))
            Text("Wallet Balance", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onPrimaryContainer)
            Text(
                if (me != null) "$ ${"%.2f".format(me.walletBalance)}" else "…",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            if (me?.status == "suspended") {
                Spacer(Modifier.height(6.dp))
                Text(
                    "Account suspended — contact Admin",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

private fun resellerStatusColor(status: String): Color = when (status) {
    "completed", "confirmed", "verified" -> DalabSuccessGreen
    "pending", "reserved", "sent", "payment_sent" -> DalabWarningAmber
    "cancelled", "failed" -> DalabDangerRed
    else -> DalabOutline
}

@Composable
private fun ResellerStatusChip(status: String) {
    val color = resellerStatusColor(status)
    Surface(color = color.copy(alpha = 0.15f), shape = RoundedCornerShape(8.dp)) {
        Text(
            status.replace('_', ' ').replaceFirstChar { it.uppercase() },
            color = color,
            fontWeight = FontWeight.Bold,
            fontSize = 11.sp,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}

@Composable
private fun ResellerListCard(content: @Composable ColumnScope.() -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp), shape = RoundedCornerShape(14.dp)) {
        Column(modifier = Modifier.padding(14.dp), content = content)
    }
}

@Composable
private fun ResellerEmptyState(message: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// receivingNumber is the closest thing this system has to "which customer
// used this reseller account" -- there's no separate customer-link table,
// see data/ResellerModels.kt's header comment -- so it's always shown and
// clearly labeled here rather than treated as incidental order detail.
@Composable
private fun ResellerOrdersList(orders: List<ResellerOrder>) {
    if (orders.isEmpty()) {
        ResellerEmptyState("No orders yet.")
        return
    }
    LazyColumn(modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp)) {
        items(orders, key = { it.id }) { order ->
            ResellerListCard {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(order.companyName, fontWeight = FontWeight.Bold)
                    ResellerStatusChip(order.status)
                }
                Spacer(Modifier.height(6.dp))
                Text("Customer: +${order.receivingNumber}", style = MaterialTheme.typography.bodySmall)
                Text(
                    "Amount: \$${"%.2f".format(order.amount)}  →  \$${"%.2f".format(order.amountCalculated)}",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(4.dp))
                Text(formatApiDateTime(order.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ResellerDepositsList(deposits: List<ResellerDeposit>) {
    if (deposits.isEmpty()) {
        ResellerEmptyState("No deposits yet.")
        return
    }
    LazyColumn(modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp)) {
        items(deposits, key = { it.id }) { deposit ->
            ResellerListCard {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(deposit.methodLabel, fontWeight = FontWeight.Bold)
                    ResellerStatusChip(deposit.status)
                }
                Spacer(Modifier.height(6.dp))
                Text("From: +${deposit.fromNumber}  →  ${deposit.toNumber}", style = MaterialTheme.typography.bodySmall)
                Text("Amount: \$${"%.2f".format(deposit.amount)}", style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(4.dp))
                Text(formatApiDateTime(deposit.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ResellerWithdrawalsList(withdrawals: List<ResellerWithdrawal>, onChanged: () -> Unit) {
    if (withdrawals.isEmpty()) {
        ResellerEmptyState("No withdrawals yet.")
        return
    }
    val scope = rememberCoroutineScope()
    var cancellingId by remember { mutableStateOf<String?>(null) }

    fun cancel(id: String) {
        cancellingId = id
        scope.launch {
            try {
                ResellerApiClient.service.cancelResellerWithdrawal(id)
            } catch (_: Exception) {
                // Best-effort -- the list refresh below shows whatever the
                // server's actual current status is either way.
            }
            cancellingId = null
            onChanged()
        }
    }

    LazyColumn(modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp)) {
        items(withdrawals, key = { it.id }) { withdrawal ->
            ResellerListCard {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(withdrawal.companyName, fontWeight = FontWeight.Bold)
                    ResellerStatusChip(withdrawal.status)
                }
                Spacer(Modifier.height(6.dp))
                Text("To: +${withdrawal.destinationNumber}", style = MaterialTheme.typography.bodySmall)
                Text(
                    "Amount: \$${"%.2f".format(withdrawal.amount)}  (receives \$${"%.2f".format(withdrawal.customerReceivesAmount)})",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(4.dp))
                Text(formatApiDateTime(withdrawal.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (withdrawal.status == "reserved") {
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = { cancel(withdrawal.id) },
                        enabled = cancellingId != withdrawal.id,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = DalabDangerRed),
                        modifier = Modifier.align(Alignment.End),
                    ) {
                        Text(if (cancellingId == withdrawal.id) "Cancelling…" else "Cancel")
                    }
                }
            }
        }
    }
}

@Composable
private fun ResellerSelectOption(title: String, subtitle: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    ) {
        Row(
            modifier = Modifier.padding(12.dp).fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text(title, fontWeight = FontWeight.Bold)
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (selected) Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        }
    }
}

@Composable
private fun ResellerNewOrderForm(companies: List<ResellerCompany>, onSubmitted: () -> Unit) {
    var selectedCompany by remember { mutableStateOf<ResellerCompany?>(null) }
    var receivingNumber by remember { mutableStateOf("") }
    var amountText by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val orderableCompanies = companies.filter { it.rate != null }

    fun submit() {
        val company = selectedCompany
        val amount = amountText.toDoubleOrNull()
        if (company == null) { error = "Choose a company"; return }
        if (receivingNumber.isBlank()) { error = "Enter the customer's number"; return }
        if (amount == null || amount <= 0) { error = "Enter a valid amount"; return }
        busy = true
        error = null
        scope.launch {
            try {
                val res = ResellerApiClient.service.createResellerOrder(
                    ResellerCreateOrderRequest(company.id, receivingNumber.trim(), amount, UUID.randomUUID().toString())
                )
                if (res.isSuccessful) onSubmitted() else error = resellerErrorMessage(res, "Could not create the order")
            } catch (e: Exception) {
                error = "Could not connect. Check your internet connection."
            } finally {
                busy = false
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("Company", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        if (orderableCompanies.isEmpty()) {
            Text("No companies have a rate configured yet — ask Admin.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        orderableCompanies.forEach { company ->
            ResellerSelectOption(
                title = company.name,
                subtitle = "Rate: ${company.rate}",
                selected = selectedCompany?.id == company.id,
                onClick = { selectedCompany = company },
            )
        }
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(
            value = receivingNumber,
            onValueChange = { receivingNumber = it },
            label = { Text("Customer's Number") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = amountText,
            onValueChange = { amountText = it },
            label = { Text("Amount") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        val rate = selectedCompany?.rate
        val amount = amountText.toDoubleOrNull()
        if (rate != null && amount != null) {
            Spacer(Modifier.height(4.dp))
            Text(
                "You will pay ≈ \$${"%.2f".format(amount * rate)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (error != null) {
            Spacer(Modifier.height(8.dp))
            Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(20.dp))
        Button(onClick = ::submit, enabled = !busy, modifier = Modifier.fillMaxWidth().height(48.dp)) {
            if (busy) CircularProgressIndicator(modifier = Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
            else Text("Create Order")
        }
    }
}

@Composable
private fun ResellerNewDepositForm(methods: List<ResellerDepositMethod>, onSubmitted: () -> Unit) {
    var selectedMethod by remember { mutableStateOf<ResellerDepositMethod?>(null) }
    var fromNumber by remember { mutableStateOf("") }
    var amountText by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun submit() {
        val method = selectedMethod
        val amount = amountText.toDoubleOrNull()
        if (method == null) { error = "Choose a payment method"; return }
        if (fromNumber.isBlank()) { error = "Enter the number you sent from"; return }
        if (amount == null || amount <= 0) { error = "Enter a valid amount"; return }
        busy = true
        error = null
        scope.launch {
            try {
                val res = ResellerApiClient.service.createResellerDeposit(
                    ResellerCreateDepositRequest(method.method, fromNumber.trim(), amount, UUID.randomUUID().toString())
                )
                if (res.isSuccessful) onSubmitted() else error = resellerErrorMessage(res, "Could not create the deposit")
            } catch (e: Exception) {
                error = "Could not connect. Check your internet connection."
            } finally {
                busy = false
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text(
            "Send money to Dalab's number below, then tell us here so Admin can verify it.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))
        Text("Payment Method", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        methods.forEach { method ->
            ResellerSelectOption(
                title = method.label,
                subtitle = "Send to ${method.paymentNumber}",
                selected = selectedMethod?.method == method.method,
                onClick = { selectedMethod = method },
            )
        }
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(
            value = fromNumber,
            onValueChange = { fromNumber = it },
            label = { Text("Number You Sent From") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = amountText,
            onValueChange = { amountText = it },
            label = { Text("Amount Sent") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        if (error != null) {
            Spacer(Modifier.height(8.dp))
            Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(20.dp))
        Button(onClick = ::submit, enabled = !busy, modifier = Modifier.fillMaxWidth().height(48.dp)) {
            if (busy) CircularProgressIndicator(modifier = Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
            else Text("Submit Deposit")
        }
    }
}

@Composable
private fun ResellerNewWithdrawalForm(companies: List<ResellerCompany>, onSubmitted: () -> Unit) {
    var selectedCompany by remember { mutableStateOf<ResellerCompany?>(null) }
    var destinationNumber by remember { mutableStateOf("") }
    var amountText by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun submit() {
        val company = selectedCompany
        val amount = amountText.toDoubleOrNull()
        if (company == null) { error = "Choose a company"; return }
        if (destinationNumber.isBlank()) { error = "Enter the destination number"; return }
        if (amount == null || amount <= 0) { error = "Enter a valid amount"; return }
        busy = true
        error = null
        scope.launch {
            try {
                val res = ResellerApiClient.service.createResellerWithdrawal(
                    ResellerCreateWithdrawalRequest(company.id, destinationNumber.trim(), amount, UUID.randomUUID().toString())
                )
                if (res.isSuccessful) onSubmitted() else error = resellerErrorMessage(res, "Could not create the withdrawal")
            } catch (e: Exception) {
                error = "Could not connect. Check your internet connection."
            } finally {
                busy = false
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("Company", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        companies.forEach { company ->
            ResellerSelectOption(
                title = company.name,
                subtitle = "Bonus: ${company.withdrawCommissionPercentage}%",
                selected = selectedCompany?.id == company.id,
                onClick = { selectedCompany = company },
            )
        }
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(
            value = destinationNumber,
            onValueChange = { destinationNumber = it },
            label = { Text("Destination Number") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = amountText,
            onValueChange = { amountText = it },
            label = { Text("Amount") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        val company = selectedCompany
        val amount = amountText.toDoubleOrNull()
        if (company != null && amount != null) {
            val bonus = Math.round(amount * company.withdrawCommissionPercentage) / 100.0
            Spacer(Modifier.height(4.dp))
            Text(
                "Customer receives ≈ \$${"%.2f".format(amount + bonus)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (error != null) {
            Spacer(Modifier.height(8.dp))
            Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(20.dp))
        Button(onClick = ::submit, enabled = !busy, modifier = Modifier.fillMaxWidth().height(48.dp)) {
            if (busy) CircularProgressIndicator(modifier = Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
            else Text("Request Withdrawal")
        }
    }
}

/** Every reseller-facing error route returns `{error: "..."}` (see
 * admin-backend-ts's sendJson usage throughout resellers.routes.ts/
 * resellerOrders.routes.ts/resellerDepositsWithdrawals.routes.ts) --
 * pulls that message out verbatim so, e.g., the login screen shows the
 * exact "Invalid ID/PIN. Please contact Admin." text the backend
 * deliberately standardized, not a locally-invented paraphrase. */
private fun <T> resellerErrorMessage(response: Response<T>, fallback: String): String {
    val raw = try { response.errorBody()?.string() } catch (_: Exception) { null }
    if (raw.isNullOrBlank()) return fallback
    return try {
        JsonParser.parseString(raw).asJsonObject.get("error")?.asString ?: fallback
    } catch (_: Exception) {
        fallback
    }
}
