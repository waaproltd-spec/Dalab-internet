package com.dalab.internet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.dalab.internet.data.CustomerSummary
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.CreateCustomerRequest
import com.dalab.internet.util.validateMobileNumber
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CustomersScreen() {
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
        topBar = { TopAppBar(title = { Text("Customers") }) },
        floatingActionButton = {
            FloatingActionButton(onClick = { showAddDialog = true }) {
                Icon(Icons.Filled.Add, contentDescription = "Add customer")
            }
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it; refresh(it) },
                label = { Text("Search by name or phone") },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(16.dp),
            )

            if (error != null) {
                Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp))
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
                    LazyColumn {
                        items(customers, key = { it.id }) { customer ->
                            CustomerRow(customer)
                            Divider()
                        }
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
private fun CustomerRow(customer: CustomerSummary) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column {
            Text(customer.name?.takeIf { it.isNotBlank() } ?: "Unnamed customer", fontWeight = FontWeight.Bold)
            Text(customer.phone, style = MaterialTheme.typography.bodySmall)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text("${customer.macaashPoints} pts", style = MaterialTheme.typography.labelMedium)
            if (customer.status == "blocked") {
                Text("Blocked", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
            }
        }
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
        Surface(shape = MaterialTheme.shapes.medium) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text("New customer", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
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
                    Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
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
