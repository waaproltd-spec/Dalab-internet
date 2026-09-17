package com.dalab.internet.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.dalab.internet.data.CustomerSummary
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.CreateCustomerRequest
import com.dalab.internet.ui.theme.DalabDangerRed
import com.dalab.internet.ui.theme.DalabSurfaceTint
import com.dalab.internet.util.validateMobileNumber
import kotlinx.coroutines.launch

/** Every customer in the system, same visibility Admin has -- GET
 * /agent/customers is never scoped to "this agent's own customers" (see
 * customers.routes.ts), so no client-side filtering is layered on top here
 * either. */
@Composable
fun CustomersScreen(onBack: () -> Unit, onOpenCustomer: (String) -> Unit) {
    var customers by remember { mutableStateOf<List<CustomerSummary>>(emptyList()) }
    var query by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var showAddDialog by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun refresh(search: String = query) {
        loading = true
        scope.launch {
            try {
                val response = ApiClient.service.getCustomers(search.ifBlank { null })
                customers = response.body().orEmpty()
                error = null
            } catch (_: Exception) {
                error = "Couldn't load customers. Check your connection."
            }
            loading = false
        }
    }

    LaunchedEffect(Unit) { refresh() }

    Scaffold(
        containerColor = Color.White,
        floatingActionButton = {
            FloatingActionButton(onClick = { showAddDialog = true }, containerColor = DalabIndigo, contentColor = Color.White) {
                Icon(Icons.Filled.Add, contentDescription = "Add customer")
            }
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = DalabIndigo)
                }
                Column {
                    Text("Customers", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = DalabIndigo)
                    Text("Manage your customers", style = MaterialTheme.typography.bodySmall, color = Color(0xFF6B7280))
                }
            }

            OutlinedTextField(
                value = query,
                onValueChange = { query = it; refresh(it) },
                placeholder = { Text("Search by name or phone number") },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                singleLine = true,
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            )

            Spacer(Modifier.height(4.dp))

            if (error != null) {
                Text(error!!, color = DalabDangerRed, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodyMedium)
            }

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                if (loading) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                } else if (customers.isEmpty()) {
                    Text(
                        "No customers found.",
                        modifier = Modifier.align(Alignment.Center),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                } else {
                    LazyColumn(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(customers, key = { it.id }) { customer ->
                            CustomerRow(customer, onClick = { onOpenCustomer(customer.id) })
                        }
                        item { Spacer(Modifier.height(72.dp)) }
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
                Text(customer.phone, style = MaterialTheme.typography.bodySmall, color = Color(0xFF6B7280))
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
