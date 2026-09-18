package com.dalab.internet.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Receipt
import androidx.compose.material.icons.filled.Savings
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.Stars
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.CustomerDetail
import com.dalab.internet.data.CustomerOrderHistoryEntry
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.SetCustomerPinRequest
import com.dalab.internet.network.UpdateCustomerRequest
import com.dalab.internet.network.UpdateCustomerWalletNumbersRequest
import com.dalab.internet.ui.theme.DalabDangerRed
import com.dalab.internet.ui.theme.DalabSurfaceTint
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

private enum class DetailView { MAIN, ORDER_HISTORY, RESET_PIN, RESET_PIN_SUCCESS, SUSPEND_CONFIRM, EDIT, WALLET }

/** Same customer-management power Admin has (customers.routes.ts's
 * /agent/customers/{id}* routes) -- detail, full order history, Suspend/
 * Reactivate, and full PIN reset (generate a random one, or type a specific
 * one), all against the real backend, never mocked. Reset PIN/Suspend/Order
 * History are internal steps of this one screen (a local [DetailView], not
 * separate MainActivity destinations) since none of them are ever reachable
 * except from here. */
@Composable
fun CustomerDetailScreen(customerId: String, onBack: () -> Unit) {
    var view by remember { mutableStateOf(DetailView.MAIN) }
    var detail by remember { mutableStateOf<CustomerDetail?>(null) }
    var orders by remember { mutableStateOf<List<CustomerOrderHistoryEntry>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var generatedPin by remember { mutableStateOf<String?>(null) }
    // Surfaces a failed Activate tap (the one action on this screen with no
    // confirmation screen of its own to show an error on) -- Suspend has
    // SuspendCustomerScreen's own inline error for the same failure.
    var statusToggleError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun load() {
        loading = true
        scope.launch {
            try {
                val detailResponse = ApiClient.service.getCustomerDetail(customerId)
                if (detailResponse.isSuccessful) {
                    detail = detailResponse.body()
                    error = null
                } else {
                    error = "Couldn't load this customer."
                }
                orders = ApiClient.service.getCustomerOrders(customerId).body().orEmpty()
            } catch (_: Exception) {
                error = "Couldn't load this customer. Check your connection."
            }
            loading = false
        }
    }

    LaunchedEffect(customerId) { load() }

    when (view) {
        DetailView.MAIN -> CustomerDetailMain(
            detail = detail,
            orders = orders,
            loading = loading,
            error = error,
            statusToggleError = statusToggleError,
            onBack = onBack,
            onResetPin = { generatedPin = null; view = DetailView.RESET_PIN },
            onSuspendOrActivate = {
                detail?.let { current ->
                    if (current.status == "active") {
                        statusToggleError = null
                        view = DetailView.SUSPEND_CONFIRM
                    } else {
                        statusToggleError = null
                        scope.launch {
                            try {
                                val response = ApiClient.service.toggleCustomerBlock(customerId)
                                if (response.isSuccessful) {
                                    load()
                                } else {
                                    statusToggleError = "Couldn't activate this customer. Try again."
                                }
                            } catch (_: Exception) {
                                statusToggleError = "Couldn't activate this customer. Check your connection and try again."
                            }
                        }
                    }
                }
            },
            onViewOrders = { view = DetailView.ORDER_HISTORY },
            onEdit = { view = DetailView.EDIT },
            onWallet = { view = DetailView.WALLET },
        )

        DetailView.EDIT -> EditCustomerScreen(
            detail = detail,
            onBack = { view = DetailView.MAIN },
            onSave = { name, phone ->
                val response = ApiClient.service.updateCustomer(customerId, UpdateCustomerRequest(name, phone))
                if (response.isSuccessful) {
                    load()
                    view = DetailView.MAIN
                }
                response.isSuccessful
            },
        )

        DetailView.WALLET -> WalletNumbersScreen(
            detail = detail,
            onBack = { view = DetailView.MAIN },
            onSave = { evcPlusName, evcPlusNumber, edahabName, edahabNumber ->
                val response = ApiClient.service.updateCustomerWalletNumbers(
                    customerId,
                    UpdateCustomerWalletNumbersRequest(evcPlusName, evcPlusNumber, edahabName, edahabNumber),
                )
                if (response.isSuccessful) {
                    load()
                    view = DetailView.MAIN
                }
                response.isSuccessful
            },
        )

        DetailView.ORDER_HISTORY -> CustomerOrderHistoryScreen(
            customerName = detail?.name ?: detail?.phone ?: "Customer",
            orders = orders,
            onBack = { view = DetailView.MAIN },
        )

        DetailView.RESET_PIN -> ResetCustomerPinScreen(
            detail = detail,
            onBack = { view = DetailView.MAIN },
            onSetPin = { pin ->
                val response = ApiClient.service.setCustomerPin(customerId, SetCustomerPinRequest(pin))
                if (response.isSuccessful) {
                    generatedPin = null
                    load()
                    view = DetailView.RESET_PIN_SUCCESS
                }
                response.isSuccessful
            },
            onGeneratePin = {
                val response = ApiClient.service.generateCustomerPin(customerId)
                val body = response.body()
                if (response.isSuccessful && body != null) {
                    generatedPin = body.pin
                    load()
                    view = DetailView.RESET_PIN_SUCCESS
                }
                response.isSuccessful
            },
            onClearPin = {
                val response = ApiClient.service.clearCustomerPin(customerId)
                if (response.isSuccessful) {
                    load()
                    view = DetailView.MAIN
                }
                response.isSuccessful
            },
        )

        DetailView.RESET_PIN_SUCCESS -> PinResetSuccessScreen(
            detail = detail,
            generatedPin = generatedPin,
            onDone = { view = DetailView.MAIN },
        )

        DetailView.SUSPEND_CONFIRM -> SuspendCustomerScreen(
            detail = detail,
            onCancel = { view = DetailView.MAIN },
            onConfirm = {
                try {
                    val response = ApiClient.service.toggleCustomerBlock(customerId)
                    if (response.isSuccessful) {
                        load()
                        view = DetailView.MAIN
                    }
                    response.isSuccessful
                } catch (_: Exception) {
                    false
                }
            },
        )
    }
}

private fun formatDate(iso: String?): String {
    if (iso == null) return "—"
    return try {
        val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val date = parser.parse(iso.take(19)) ?: return iso
        SimpleDateFormat("MMM d, yyyy", Locale.US).format(date)
    } catch (_: Exception) {
        iso
    }
}

@Composable
private fun DetailTopBar(title: String, onBack: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) {
            Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = DalabIndigo)
        }
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = DalabIndigo)
    }
}

@Composable
private fun CustomerDetailMain(
    detail: CustomerDetail?,
    orders: List<CustomerOrderHistoryEntry>,
    loading: Boolean,
    error: String?,
    statusToggleError: String?,
    onBack: () -> Unit,
    onResetPin: () -> Unit,
    onSuspendOrActivate: () -> Unit,
    onViewOrders: () -> Unit,
    onEdit: () -> Unit,
    onWallet: () -> Unit,
) {
    Scaffold(containerColor = Color.White) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            DetailTopBar("Customer Details", onBack)

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                if (loading && detail == null) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                } else if (detail == null) {
                    Text(error ?: "Customer not found.", modifier = Modifier.align(Alignment.Center), style = MaterialTheme.typography.bodyMedium)
                } else {
                    val suspended = detail.status == "blocked"
                    LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        item {
                            Surface(color = Color.White, shape = RoundedCornerShape(16.dp), shadowElevation = 1.dp, modifier = Modifier.fillMaxWidth()) {
                                Column(modifier = Modifier.padding(18.dp)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        CustomerAvatar(name = detail.name, phone = detail.phone, size = 52)
                                        Spacer(Modifier.width(14.dp))
                                        Column(modifier = Modifier.weight(1f)) {
                                            Row(verticalAlignment = Alignment.CenterVertically) {
                                                Text(detail.name?.takeIf { it.isNotBlank() } ?: "Unnamed customer", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium, color = DalabIndigo)
                                                Spacer(Modifier.width(8.dp))
                                                StatusPill(label = if (suspended) "Suspended" else "Active", danger = suspended)
                                            }
                                            Text(detail.phone, style = MaterialTheme.typography.bodyMedium, color = Color(0xFF6B7280))
                                        }
                                    }
                                    Spacer(Modifier.height(6.dp))
                                    Text("Customer since ${formatDate(detail.createdAt)}", style = MaterialTheme.typography.labelSmall, color = Color(0xFF9CA3AF))
                                }
                            }
                        }

                        item {
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                                StatCard(icon = Icons.Filled.ShoppingCart, label = "Total Orders", value = "${detail.totalOrders}", modifier = Modifier.weight(1f))
                                StatCard(icon = Icons.Filled.Savings, label = "Total Spent", value = "$${"%.2f".format(detail.totalSpent)}", modifier = Modifier.weight(1f))
                                StatCard(icon = Icons.Filled.Stars, label = "Macaash Points", value = "${detail.macaashPoints}", modifier = Modifier.weight(1f))
                            }
                        }

                        item {
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                                ActionButton(icon = Icons.Filled.Edit, label = "Edit", color = DalabIndigo, onClick = onEdit, modifier = Modifier.weight(1f))
                                ActionButton(icon = Icons.Filled.Lock, label = "Reset PIN", color = DalabIndigo, onClick = onResetPin, modifier = Modifier.weight(1f))
                                ActionButton(icon = Icons.Filled.AccountBalanceWallet, label = "Wallet", color = DalabIndigo, onClick = onWallet, modifier = Modifier.weight(1f))
                            }
                        }
                        item {
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                                ActionButton(
                                    icon = if (suspended) Icons.Filled.CheckCircle else Icons.Filled.Block,
                                    label = if (suspended) "Activate" else "Suspend",
                                    color = if (suspended) DalabGreen else DalabDangerRed,
                                    onClick = onSuspendOrActivate,
                                    modifier = Modifier.weight(1f),
                                )
                                ActionButton(icon = Icons.Filled.Receipt, label = "View Orders", color = DalabIndigo, onClick = onViewOrders, modifier = Modifier.weight(1f))
                                Spacer(Modifier.weight(1f))
                            }
                        }

                        if (statusToggleError != null) {
                            item {
                                Surface(color = DalabDangerRed.copy(alpha = 0.08f), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                                    Text(
                                        statusToggleError,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = DalabDangerRed,
                                        modifier = Modifier.padding(12.dp),
                                    )
                                }
                            }
                        }

                        item { SectionLabel("Customer Information") }
                        item {
                            Surface(color = Color.White, shape = RoundedCornerShape(14.dp), shadowElevation = 1.dp, modifier = Modifier.fillMaxWidth()) {
                                Column(modifier = Modifier.padding(vertical = 4.dp)) {
                                    InfoRow(Icons.Filled.Person, "Name", detail.name?.takeIf { it.isNotBlank() } ?: "—")
                                    InfoRow(Icons.Filled.Phone, "Phone Number", detail.phone)
                                    InfoRow(Icons.Filled.CheckCircle, "Account Status", if (suspended) "Suspended" else "Active")
                                    InfoRow(
                                        Icons.Filled.AccountBalanceWallet,
                                        "EVC Plus",
                                        detail.evcPlusNumber?.takeIf { it.isNotBlank() } ?: "Not set",
                                    )
                                    InfoRow(
                                        Icons.Filled.AccountBalanceWallet,
                                        "eDahab",
                                        detail.edahabNumber?.takeIf { it.isNotBlank() } ?: "Not set",
                                    )
                                    InfoRow(Icons.Filled.CalendarToday, "Joined Date", formatDate(detail.createdAt), showDivider = false)
                                }
                            }
                        }

                        item { SectionLabel("Recent Orders") }
                        if (orders.isEmpty()) {
                            item {
                                Text("No orders yet.", style = MaterialTheme.typography.bodyMedium, color = Color(0xFF6B7280), modifier = Modifier.padding(vertical = 8.dp))
                            }
                        } else {
                            items(orders.take(3), key = { it.id }) { order -> RecentOrderRow(order) }
                        }

                        if (suspended) {
                            item {
                                Surface(color = DalabDangerRed.copy(alpha = 0.08f), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                                    Text(
                                        "This customer's account is currently suspended. They cannot log in or place new orders.",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = DalabDangerRed,
                                        modifier = Modifier.padding(12.dp),
                                    )
                                }
                            }
                        }

                        item { Spacer(Modifier.height(16.dp)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = DalabIndigo, modifier = Modifier.padding(top = 4.dp, bottom = 2.dp))
}

@Composable
private fun StatCard(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, value: String, modifier: Modifier = Modifier) {
    Surface(color = DalabSoftBlue.copy(alpha = 0.25f), shape = RoundedCornerShape(14.dp), modifier = modifier) {
        Row(modifier = Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(modifier = Modifier.size(34.dp).background(Color.White, CircleShape), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = DalabIndigo, modifier = Modifier.size(17.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column {
                Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = DalabIndigo)
                Text(label, style = MaterialTheme.typography.labelSmall, color = Color(0xFF6B7280))
            }
        }
    }
}

@Composable
private fun ActionButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, color: Color, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        color = color.copy(alpha = 0.10f),
        contentColor = color,
        shape = RoundedCornerShape(12.dp),
        modifier = modifier.clickable(onClick = onClick),
    ) {
        Column(modifier = Modifier.padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.height(4.dp))
            Text(label, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, maxLines = 1)
        }
    }
}

@Composable
private fun InfoRow(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, value: String, showDivider: Boolean = true) {
    Column {
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = Color(0xFF9CA3AF), modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(10.dp))
            Text(label, style = MaterialTheme.typography.bodySmall, color = Color(0xFF6B7280), modifier = Modifier.weight(1f))
            Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = DalabIndigo)
        }
        if (showDivider) Divider(color = DalabSurfaceTint)
    }
}

@Composable
private fun RecentOrderRow(order: CustomerOrderHistoryEntry) {
    Surface(color = Color.White, shape = RoundedCornerShape(12.dp), shadowElevation = 1.dp, modifier = Modifier.fillMaxWidth()) {
        Row(modifier = Modifier.padding(14.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text("${order.companyName} · ${order.packageName}", fontWeight = FontWeight.SemiBold, color = DalabIndigo, style = MaterialTheme.typography.bodyMedium)
                Text(formatDate(order.createdAt), style = MaterialTheme.typography.labelSmall, color = Color(0xFF9CA3AF))
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("$${"%.2f".format(order.amount)}", fontWeight = FontWeight.Bold, color = DalabGreen)
                OrderStatusPill(order.status)
            }
        }
    }
}

@Composable
private fun OrderStatusPill(status: String) {
    val label = when (status) {
        "completed" -> "Completed"
        "failed" -> "Failed"
        "cancelled" -> "Cancelled"
        "in_progress" -> "Processing"
        else -> "Pending"
    }
    val color = if (status == "failed" || status == "cancelled") DalabDangerRed else DalabGreen
    Surface(color = color.copy(alpha = 0.12f), contentColor = color, shape = RoundedCornerShape(999.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp))
    }
}

// ---------------- Order history (full list) ----------------

@Composable
private fun CustomerOrderHistoryScreen(customerName: String, orders: List<CustomerOrderHistoryEntry>, onBack: () -> Unit) {
    Scaffold(containerColor = Color.White) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            DetailTopBar("$customerName's Orders", onBack)
            if (orders.isEmpty()) {
                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    Text("No orders yet.", modifier = Modifier.align(Alignment.Center), style = MaterialTheme.typography.bodyMedium)
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(orders, key = { it.id }) { order -> RecentOrderRow(order) }
                }
            }
        }
    }
}

// ---------------- Reset PIN ----------------

@Composable
private fun ResetCustomerPinScreen(
    detail: CustomerDetail?,
    onBack: () -> Unit,
    onSetPin: suspend (String) -> Boolean,
    onGeneratePin: suspend () -> Boolean,
    onClearPin: suspend () -> Boolean,
) {
    var pin by remember { mutableStateOf("") }
    var confirmPin by remember { mutableStateOf("") }
    var pinVisible by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val pinValid = pin.length in 4..8 && pin.all { it.isDigit() }
    val matches = pin == confirmPin

    Scaffold(containerColor = Color.White) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState())) {
            DetailTopBar("Reset Customer PIN", onBack)

            Column(modifier = Modifier.padding(horizontal = 20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(modifier = Modifier.size(64.dp).background(DalabSoftBlue.copy(alpha = 0.4f), CircleShape), contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.Lock, contentDescription = null, tint = DalabIndigo, modifier = Modifier.size(30.dp))
                }
                Spacer(Modifier.height(14.dp))
                Text("Set a New PIN", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = DalabIndigo)
                Spacer(Modifier.height(4.dp))
                Text(
                    "Create a new PIN for ${detail?.name?.takeIf { it.isNotBlank() } ?: detail?.phone ?: "this customer"}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFF6B7280),
                )

                Spacer(Modifier.height(24.dp))

                OutlinedTextField(
                    value = pin,
                    onValueChange = { if (it.length <= 8 && it.all { c -> c.isDigit() }) pin = it },
                    label = { Text("Enter new PIN (4-8 digits)") },
                    singleLine = true,
                    visualTransformation = if (pinVisible) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    trailingIcon = {
                        IconButton(onClick = { pinVisible = !pinVisible }) {
                            Icon(if (pinVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility, contentDescription = "Toggle visibility")
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = confirmPin,
                    onValueChange = { if (it.length <= 8 && it.all { c -> c.isDigit() }) confirmPin = it },
                    label = { Text("Confirm new PIN") },
                    singleLine = true,
                    isError = confirmPin.isNotEmpty() && !matches,
                    visualTransformation = if (pinVisible) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    supportingText = if (confirmPin.isNotEmpty() && !matches) {
                        { Text("PINs don't match") }
                    } else null,
                    modifier = Modifier.fillMaxWidth(),
                )

                Spacer(Modifier.height(14.dp))

                Surface(color = DalabSoftBlue.copy(alpha = 0.2f), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                    Text(
                        "The customer will use this new PIN to log in to their account. The old PIN will no longer work.",
                        style = MaterialTheme.typography.bodySmall,
                        color = DalabIndigo,
                        modifier = Modifier.padding(12.dp),
                    )
                }

                if (error != null) {
                    Spacer(Modifier.height(10.dp))
                    Text(error!!, color = DalabDangerRed, style = MaterialTheme.typography.bodySmall)
                }

                Spacer(Modifier.height(20.dp))

                Button(
                    onClick = {
                        error = null
                        saving = true
                        scope.launch {
                            if (!onSetPin(pin)) error = "Couldn't reset this PIN. Try again."
                            saving = false
                        }
                    },
                    enabled = pinValid && matches && !saving,
                    colors = ButtonDefaults.buttonColors(containerColor = DalabIndigo),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) {
                    Text(if (saving) "Resetting…" else "Reset PIN")
                }

                Spacer(Modifier.height(10.dp))

                OutlinedButton(
                    onClick = {
                        error = null
                        saving = true
                        scope.launch {
                            if (!onGeneratePin()) error = "Couldn't generate a PIN. Try again."
                            saving = false
                        }
                    },
                    enabled = !saving,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) {
                    Text("Generate a random PIN instead")
                }

                if (detail?.pinSet == true) {
                    Spacer(Modifier.height(10.dp))
                    OutlinedButton(
                        onClick = {
                            error = null
                            saving = true
                            scope.launch {
                                if (!onClearPin()) error = "Couldn't clear this PIN. Try again."
                                saving = false
                            }
                        },
                        enabled = !saving,
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = DalabDangerRed),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                    ) {
                        Text("Clear PIN entirely")
                    }
                }

                Spacer(Modifier.height(8.dp))

                TextButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) {
                    Text("Cancel")
                }

                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

@Composable
private fun PinResetSuccessScreen(detail: CustomerDetail?, generatedPin: String?, onDone: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    Scaffold(containerColor = Color.White) { padding ->
        Column(
            modifier = Modifier.padding(padding).fillMaxSize().padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(48.dp))
            Box(modifier = Modifier.size(72.dp).background(DalabGreen.copy(alpha = 0.15f), CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = DalabGreen, modifier = Modifier.size(38.dp))
            }
            Spacer(Modifier.height(18.dp))
            Text("PIN Reset Successfully", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = DalabIndigo)
            Spacer(Modifier.height(6.dp))
            Text(
                "The customer's PIN has been updated successfully.",
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF6B7280),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )

            Spacer(Modifier.height(24.dp))

            Surface(color = Color.White, shape = RoundedCornerShape(14.dp), shadowElevation = 1.dp, modifier = Modifier.fillMaxWidth()) {
                Row(modifier = Modifier.padding(14.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    CustomerAvatar(name = detail?.name, phone = detail?.phone ?: "")
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text(detail?.name?.takeIf { it.isNotBlank() } ?: "Customer", fontWeight = FontWeight.SemiBold, color = DalabIndigo)
                        Text(detail?.phone ?: "", style = MaterialTheme.typography.bodySmall, color = Color(0xFF6B7280))
                    }
                }
            }

            if (generatedPin != null) {
                Spacer(Modifier.height(14.dp))
                Surface(color = DalabSoftBlue.copy(alpha = 0.25f), shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                    Row(modifier = Modifier.padding(16.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("New PIN", style = MaterialTheme.typography.labelSmall, color = Color(0xFF6B7280))
                            Text(generatedPin, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = DalabIndigo)
                        }
                        IconButton(onClick = { clipboard.setText(AnnotatedString(generatedPin)) }) {
                            Icon(Icons.Filled.ContentCopy, contentDescription = "Copy PIN", tint = DalabIndigo)
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    "Relay this PIN to the customer now — it won't be shown again.",
                    style = MaterialTheme.typography.labelSmall,
                    color = Color(0xFF9CA3AF),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }

            Spacer(Modifier.height(18.dp))

            Surface(color = DalabSurfaceTint, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                Row(modifier = Modifier.padding(12.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Lock, contentDescription = null, tint = DalabIndigo, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("The customer can now log in using the new PIN.", style = MaterialTheme.typography.bodySmall, color = DalabIndigo)
                }
            }

            Spacer(Modifier.weight(1f))

            Button(
                onClick = onDone,
                colors = ButtonDefaults.buttonColors(containerColor = DalabIndigo),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) {
                Text("Done")
            }
            Spacer(Modifier.height(20.dp))
        }
    }
}

// ---------------- Suspend confirmation ----------------

@Composable
private fun SuspendCustomerScreen(detail: CustomerDetail?, onCancel: () -> Unit, onConfirm: suspend () -> Boolean) {
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Scaffold(containerColor = Color.White) { padding ->
        Column(
            modifier = Modifier.padding(padding).fillMaxSize().padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            DetailTopBar("Suspend Customer", onCancel)

            Spacer(Modifier.height(20.dp))
            Box(modifier = Modifier.size(72.dp).background(DalabDangerRed.copy(alpha = 0.12f), CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Block, contentDescription = null, tint = DalabDangerRed, modifier = Modifier.size(36.dp))
            }
            Spacer(Modifier.height(18.dp))
            Text("Suspend Customer", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = DalabIndigo)
            Spacer(Modifier.height(6.dp))
            Text(
                "Are you sure you want to suspend this customer?",
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF6B7280),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )

            Spacer(Modifier.height(20.dp))

            Surface(color = Color.White, shape = RoundedCornerShape(14.dp), shadowElevation = 1.dp, modifier = Modifier.fillMaxWidth()) {
                Row(modifier = Modifier.padding(14.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    CustomerAvatar(name = detail?.name, phone = detail?.phone ?: "")
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text(detail?.name?.takeIf { it.isNotBlank() } ?: "Customer", fontWeight = FontWeight.SemiBold, color = DalabIndigo)
                        Text(detail?.phone ?: "", style = MaterialTheme.typography.bodySmall, color = Color(0xFF6B7280))
                    }
                }
            }

            Spacer(Modifier.height(14.dp))

            Surface(color = DalabDangerRed.copy(alpha = 0.08f), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(14.dp)) {
                    listOf(
                        "The customer will not be able to log in.",
                        "They cannot place new orders.",
                        "They cannot use customer services.",
                        "Their existing data and orders will be kept safe.",
                        "You can re-activate them later.",
                    ).forEach { line ->
                        Text("• $line", style = MaterialTheme.typography.bodySmall, color = DalabDangerRed, modifier = Modifier.padding(vertical = 2.dp))
                    }
                }
            }

            if (error != null) {
                Spacer(Modifier.height(10.dp))
                Text(error!!, color = DalabDangerRed, style = MaterialTheme.typography.bodySmall)
            }

            Spacer(Modifier.weight(1f))

            Button(
                onClick = {
                    error = null
                    saving = true
                    scope.launch {
                        if (!onConfirm()) error = "Couldn't suspend this customer. Try again."
                        saving = false
                    }
                },
                enabled = !saving,
                colors = ButtonDefaults.buttonColors(containerColor = DalabDangerRed),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) {
                Text(if (saving) "Suspending…" else "Suspend Customer")
            }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onCancel, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().height(48.dp)) {
                Text("Cancel")
            }
            Spacer(Modifier.height(20.dp))
        }
    }
}

// ---------------- Edit customer info ----------------

@Composable
private fun EditCustomerScreen(detail: CustomerDetail?, onBack: () -> Unit, onSave: suspend (String, String) -> Boolean) {
    var name by remember(detail?.id) { mutableStateOf(detail?.name ?: "") }
    var phone by remember(detail?.id) { mutableStateOf(detail?.phone ?: "") }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Scaffold(containerColor = Color.White) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState())) {
            DetailTopBar("Edit Customer", onBack)

            Column(modifier = Modifier.padding(horizontal = 20.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = phone,
                    onValueChange = { if (it.all { c -> c.isDigit() }) phone = it },
                    label = { Text("Phone Number") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    modifier = Modifier.fillMaxWidth(),
                )

                if (error != null) {
                    Spacer(Modifier.height(10.dp))
                    Text(error!!, color = DalabDangerRed, style = MaterialTheme.typography.bodySmall)
                }

                Spacer(Modifier.height(20.dp))

                Button(
                    onClick = {
                        error = null
                        saving = true
                        scope.launch {
                            if (!onSave(name.trim(), phone.trim())) error = "Couldn't save these changes. Check the phone number and try again."
                            saving = false
                        }
                    },
                    enabled = phone.isNotBlank() && !saving,
                    colors = ButtonDefaults.buttonColors(containerColor = DalabIndigo),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) {
                    Text(if (saving) "Saving…" else "Save Changes")
                }
                Spacer(Modifier.height(8.dp))
                TextButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) {
                    Text("Cancel")
                }
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

// ---------------- Wallet numbers (EVC Plus / eDahab) ----------------

@Composable
private fun WalletNumbersScreen(
    detail: CustomerDetail?,
    onBack: () -> Unit,
    onSave: suspend (String?, String?, String?, String?) -> Boolean,
) {
    var evcPlusName by remember(detail?.id) { mutableStateOf(detail?.evcPlusName ?: "") }
    var evcPlusNumber by remember(detail?.id) { mutableStateOf(detail?.evcPlusNumber ?: "") }
    var edahabName by remember(detail?.id) { mutableStateOf(detail?.edahabName ?: "") }
    var edahabNumber by remember(detail?.id) { mutableStateOf(detail?.edahabNumber ?: "") }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // Each wallet is a name+number pair, saved or cleared together -- same
    // rule the backend enforces (walletPairError in customers.routes.ts).
    val evcValid = evcPlusName.isBlank() == evcPlusNumber.isBlank()
    val edahabValid = edahabName.isBlank() == edahabNumber.isBlank()

    Scaffold(containerColor = Color.White) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState())) {
            DetailTopBar("Wallet Numbers", onBack)

            Column(modifier = Modifier.padding(horizontal = 20.dp)) {
                Text("EVC Plus", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = DalabIndigo)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = evcPlusName,
                    onValueChange = { evcPlusName = it },
                    label = { Text("Name on account") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = evcPlusNumber,
                    onValueChange = { if (it.all { c -> c.isDigit() }) evcPlusNumber = it },
                    label = { Text("Number") },
                    singleLine = true,
                    isError = !evcValid,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    supportingText = if (!evcValid) { { Text("Provide both a name and a number, or clear both") } } else null,
                    modifier = Modifier.fillMaxWidth(),
                )

                Spacer(Modifier.height(18.dp))

                Text("eDahab", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = DalabIndigo)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = edahabName,
                    onValueChange = { edahabName = it },
                    label = { Text("Name on account") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = edahabNumber,
                    onValueChange = { if (it.all { c -> c.isDigit() }) edahabNumber = it },
                    label = { Text("Number") },
                    singleLine = true,
                    isError = !edahabValid,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    supportingText = if (!edahabValid) { { Text("Provide both a name and a number, or clear both") } } else null,
                    modifier = Modifier.fillMaxWidth(),
                )

                if (error != null) {
                    Spacer(Modifier.height(10.dp))
                    Text(error!!, color = DalabDangerRed, style = MaterialTheme.typography.bodySmall)
                }

                Spacer(Modifier.height(20.dp))

                Button(
                    onClick = {
                        error = null
                        saving = true
                        scope.launch {
                            val ok = onSave(
                                evcPlusName.trim().ifBlank { null },
                                evcPlusNumber.trim().ifBlank { null },
                                edahabName.trim().ifBlank { null },
                                edahabNumber.trim().ifBlank { null },
                            )
                            if (!ok) error = "Couldn't save wallet numbers. Try again."
                            saving = false
                        }
                    },
                    enabled = evcValid && edahabValid && !saving,
                    colors = ButtonDefaults.buttonColors(containerColor = DalabIndigo),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) {
                    Text(if (saving) "Saving…" else "Save Wallet Numbers")
                }
                Spacer(Modifier.height(8.dp))
                TextButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) {
                    Text("Cancel")
                }
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}
