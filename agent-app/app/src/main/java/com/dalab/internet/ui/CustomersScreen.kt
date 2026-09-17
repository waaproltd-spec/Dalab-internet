package com.dalab.internet.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SwapVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.dalab.internet.data.CustomerSummary
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.CreateCustomerRequest
import com.dalab.internet.ui.theme.DalabDangerRed
import com.dalab.internet.util.validateMobileNumber
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

private enum class CustomerFilterTab(val label: String) {
    ALL("All"),
    NEW("New"),
    RECENT("Recent"),
    A_Z("A-Z"),
}

private fun parseCreatedAt(iso: String): Long = try {
    val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    parser.parse(iso.take(19))?.time ?: 0L
} catch (_: Exception) {
    0L
}

private fun isSameCalendarMonth(epochMillis: Long): Boolean {
    val now = Calendar.getInstance()
    val then = Calendar.getInstance().apply { timeInMillis = epochMillis }
    return now.get(Calendar.YEAR) == then.get(Calendar.YEAR) && now.get(Calendar.MONTH) == then.get(Calendar.MONTH)
}

private const val RECENT_WINDOW_MS = 7L * 24 * 60 * 60 * 1000

/** "252611234567"/"0611234567"/"611234567" all normalize to the same
 * "+252 61 123 4567" display -- anything that isn't recognizably a 9-digit
 * Somali local number (see PhoneValidator.kt) is shown exactly as stored
 * rather than mangled into a wrong-looking format. */
private fun formatSomaliPhone(raw: String): String {
    val digits = raw.filter { it.isDigit() }
    val nine = when {
        digits.length == 9 -> digits
        digits.length == 12 && digits.startsWith("252") -> digits.substring(3)
        digits.length == 10 && digits.startsWith("0") -> digits.substring(1)
        else -> return raw
    }
    return "+252 ${nine.substring(0, 2)} ${nine.substring(2, 5)} ${nine.substring(5, 9)}"
}

/** Every customer in the system, same visibility Admin has -- GET
 * /agent/customers is never scoped to "this agent's own customers" (see
 * customers.routes.ts). Fetched once, unfiltered; search text, the filter
 * tabs, and the sort-direction toggle are all applied client-side so
 * "Total Customers"/"New This Month" always reflect the real full set
 * regardless of what's currently typed in the search box. No Macaash
 * points anywhere on this screen -- that's real backend data too, just
 * deliberately not part of this view, per product decision. */
@Composable
fun CustomersScreen(onBack: () -> Unit, onOpenCustomer: (String) -> Unit) {
    var allCustomers by remember { mutableStateOf<List<CustomerSummary>>(emptyList()) }
    var query by remember { mutableStateOf("") }
    var tab by remember { mutableStateOf(CustomerFilterTab.ALL) }
    var sortAscending by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var showAddDialog by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun refresh() {
        loading = true
        scope.launch {
            try {
                allCustomers = ApiClient.service.getCustomers(null).body().orEmpty()
                error = null
            } catch (_: Exception) {
                error = "Couldn't load customers. Check your connection."
            }
            loading = false
        }
    }

    LaunchedEffect(Unit) { refresh() }

    val newThisMonthCount = remember(allCustomers) { allCustomers.count { isSameCalendarMonth(parseCreatedAt(it.createdAt)) } }

    val visible = remember(allCustomers, query, tab, sortAscending) {
        var list = allCustomers
        if (query.isNotBlank()) {
            val queryDigits = query.filter { it.isDigit() }
            list = list.filter { c ->
                (c.name?.contains(query, ignoreCase = true) == true) ||
                    (queryDigits.isNotEmpty() && c.phone.filter { d -> d.isDigit() }.contains(queryDigits))
            }
        }
        list = when (tab) {
            CustomerFilterTab.ALL -> list.sortedByDescending { parseCreatedAt(it.createdAt) }
            CustomerFilterTab.NEW -> list.filter { isSameCalendarMonth(parseCreatedAt(it.createdAt)) }.sortedByDescending { parseCreatedAt(it.createdAt) }
            CustomerFilterTab.RECENT -> list.filter { System.currentTimeMillis() - parseCreatedAt(it.createdAt) <= RECENT_WINDOW_MS }
                .sortedByDescending { parseCreatedAt(it.createdAt) }
            CustomerFilterTab.A_Z -> list.sortedBy { (it.name?.takeIf { n -> n.isNotBlank() } ?: it.phone).lowercase() }
        }
        if (sortAscending) list.reversed() else list
    }

    Scaffold(containerColor = Color.White) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            CustomersHeader(onBack = onBack, onAddCustomer = { showAddDialog = true })

            Column(modifier = Modifier.padding(horizontal = 16.dp)) {
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    CustomerStatCard(label = "Total Customers", value = "${allCustomers.size}", color = DalabIndigo, modifier = Modifier.weight(1f))
                    CustomerStatCard(label = "New This Month", value = "$newThisMonthCount", color = DalabGreen, modifier = Modifier.weight(1f))
                }

                Spacer(Modifier.height(14.dp))

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        placeholder = { Text("Search by name or phone number") },
                        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                        singleLine = true,
                        shape = RoundedCornerShape(14.dp),
                        modifier = Modifier.weight(1f),
                    )
                    Surface(
                        color = DalabSoftBlue.copy(alpha = 0.25f),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.size(52.dp).clickable { sortAscending = !sortAscending },
                    ) {
                        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
                            Icon(Icons.Filled.SwapVert, contentDescription = "Reverse sort order", tint = DalabIndigo)
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    CustomerFilterTab.entries.forEach { t ->
                        FilterPill(label = t.label, selected = tab == t, onClick = { tab = t })
                    }
                }
            }

            Spacer(Modifier.height(8.dp))

            if (error != null) {
                Text(error!!, color = DalabDangerRed, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodyMedium)
            }

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                if (loading) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                } else if (visible.isEmpty()) {
                    Text(
                        if (query.isBlank()) "No customers found." else "No customers match \"$query\".",
                        modifier = Modifier.align(Alignment.Center),
                        style = MaterialTheme.typography.bodyMedium,
                        color = Color(0xFF6B7280),
                    )
                } else {
                    LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(visible, key = { it.id }) { customer ->
                            CustomerRow(customer, onClick = { onOpenCustomer(customer.id) })
                        }
                        item { Spacer(Modifier.height(16.dp)) }
                    }
                }
            }
        }
    }

    if (showAddDialog) {
        AddCustomerDialog(
            onDismiss = { showAddDialog = false },
            onSaved = { showAddDialog = false; refresh() },
        )
    }
}

@Composable
private fun CustomersHeader(onBack: () -> Unit, onAddCustomer: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                Brush.linearGradient(listOf(DalabIndigo, DalabSoftBlue)),
                shape = RoundedCornerShape(bottomStart = 24.dp, bottomEnd = 24.dp),
            )
            .padding(horizontal = 8.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
        }
        Column(modifier = Modifier.weight(1f)) {
            Text("Customers", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = Color.White)
            Text("Manage your customers", style = MaterialTheme.typography.bodySmall, color = Color.White.copy(alpha = 0.85f))
        }
        Surface(color = Color.White, shape = CircleShape, modifier = Modifier.clickable(onClick = onAddCustomer)) {
            Box(modifier = Modifier.size(44.dp), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.PersonAdd, contentDescription = "Add customer", tint = DalabIndigo, modifier = Modifier.size(20.dp))
            }
        }
        Spacer(Modifier.width(4.dp))
    }
}

@Composable
private fun CustomerStatCard(label: String, value: String, color: Color, modifier: Modifier = Modifier) {
    Surface(color = color.copy(alpha = 0.12f), shape = RoundedCornerShape(14.dp), modifier = modifier) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = color, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            Text(value, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold, color = color)
        }
    }
}

@Composable
private fun FilterPill(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        color = if (selected) DalabIndigo else Color.White,
        contentColor = if (selected) Color.White else DalabIndigo,
        shape = RoundedCornerShape(999.dp),
        border = if (selected) null else BorderStroke(1.dp, Color(0xFFE5E7EB)),
        modifier = Modifier.clickable(onClick = onClick),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun CustomerRow(customer: CustomerSummary, onClick: () -> Unit) {
    Surface(color = Color.White, shape = RoundedCornerShape(14.dp), shadowElevation = 1.dp, modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CustomerAvatar(name = customer.name, phone = customer.phone)
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(customer.name?.takeIf { it.isNotBlank() } ?: "Unnamed customer", fontWeight = FontWeight.SemiBold, color = DalabIndigo, style = MaterialTheme.typography.bodyLarge)
                Text(formatSomaliPhone(customer.phone), style = MaterialTheme.typography.bodySmall, color = Color(0xFF6B7280))
            }
            if (customer.status == "blocked") {
                Spacer(Modifier.width(8.dp))
                StatusPill(label = "Suspended", danger = true)
                Spacer(Modifier.width(8.dp))
            }
            Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = Color(0xFF9CA3AF))
        }
    }
}

@Composable
internal fun CustomerAvatar(name: String?, phone: String, size: Int = 40) {
    val initial = (name?.trim()?.firstOrNull()?.takeIf { it.isLetter() } ?: phone.lastOrNull() ?: '?').uppercaseChar()
    Box(
        modifier = Modifier.size(size.dp).background(DalabSoftBlue.copy(alpha = 0.5f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(initial.toString(), fontWeight = FontWeight.Bold, color = DalabIndigo)
    }
}

@Composable
internal fun StatusPill(label: String, danger: Boolean) {
    Surface(
        color = if (danger) DalabDangerRed.copy(alpha = 0.12f) else DalabGreen.copy(alpha = 0.14f),
        contentColor = if (danger) DalabDangerRed else DalabGreen,
        shape = RoundedCornerShape(999.dp),
    ) {
        Text(label, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp))
    }
}

@Composable
private fun AddCustomerDialog(onDismiss: () -> Unit, onSaved: () -> Unit) {
    var phone by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Dialog(onDismissRequest = onDismiss) {
        Surface(shape = RoundedCornerShape(16.dp), color = Color.White) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text("New customer", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = DalabIndigo)
                Spacer(Modifier.height(16.dp))
                val phoneError = if (phone.isNotBlank()) validateMobileNumber(phone.trim()).error else null
                OutlinedTextField(
                    value = phone,
                    onValueChange = { phone = it },
                    label = { Text("Phone number") },
                    singleLine = true,
                    isError = phoneError != null,
                    supportingText = phoneError?.let { { Text(it) } },
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name (optional)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (error != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(error!!, color = DalabDangerRed, style = MaterialTheme.typography.bodySmall)
                }
                Spacer(Modifier.height(20.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("Cancel") }
                    Spacer(Modifier.width(8.dp))
                    Button(
                        onClick = {
                            error = null
                            saving = true
                            scope.launch {
                                try {
                                    val response = ApiClient.service.createCustomer(
                                        CreateCustomerRequest(phone.trim(), name.trim().ifBlank { null })
                                    )
                                    if (response.isSuccessful) onSaved()
                                    else error = "Couldn't add this customer — check the phone number."
                                } catch (_: Exception) {
                                    error = "Network error while saving."
                                }
                                saving = false
                            }
                        },
                        enabled = phone.isNotBlank() && phoneError == null && !saving,
                    ) {
                        Text(if (saving) "Saving..." else "Save")
                    }
                }
            }
        }
    }
}
