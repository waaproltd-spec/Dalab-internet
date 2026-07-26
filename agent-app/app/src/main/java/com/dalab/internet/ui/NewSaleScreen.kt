package com.dalab.internet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.Company
import com.dalab.internet.data.Order
import com.dalab.internet.data.PackageItem
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.CreateSaleRequest
import kotlinx.coroutines.launch

/**
 * Agent-initiated sale for a walk-in customer: pick a provider, pick a
 * package, enter the customer's phone (and payment method), submit. Posts to
 * POST /agent/orders, which looks up or creates the customer by phone the
 * same way OTP verify does for the Customer App.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewSaleScreen() {
    var companies by remember { mutableStateOf<List<Company>>(emptyList()) }
    var selectedCompany by remember { mutableStateOf<Company?>(null) }
    var packages by remember { mutableStateOf<List<PackageItem>>(emptyList()) }
    var selectedPackage by remember { mutableStateOf<PackageItem?>(null) }
    var customerPhone by remember { mutableStateOf("") }
    var receiverPhone by remember { mutableStateOf("") }
    var paymentMethod by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var success by remember { mutableStateOf<Order?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        try {
            companies = ApiClient.service.getCompanies().body().orEmpty()
        } catch (_: Exception) {
            error = "Couldn't load providers. Check your connection."
        }
    }

    LaunchedEffect(selectedCompany) {
        val company = selectedCompany
        selectedPackage = null
        paymentMethod = company?.gateway ?: ""
        if (company != null) {
            try {
                packages = ApiClient.service.getPackages(company.id).body().orEmpty()
            } catch (_: Exception) {
                packages = emptyList()
            }
        } else {
            packages = emptyList()
        }
    }

    fun reset() {
        selectedCompany = null
        selectedPackage = null
        customerPhone = ""
        receiverPhone = ""
        paymentMethod = ""
        success = null
        error = null
    }

    Scaffold(topBar = { TopAppBar(title = { Text("New Sale") }) }) { padding ->
        if (success != null) {
            SaleConfirmation(order = success!!, onNewSale = { reset() })
        } else {
            LazyColumn(modifier = Modifier.padding(padding).fillMaxSize().padding(16.dp)) {
                item {
                    Text("1. Provider", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(8.dp))
                }
                items(companies, key = { it.id }) { company ->
                    CompanyOption(
                        company = company,
                        selected = company.id == selectedCompany?.id,
                        onClick = { selectedCompany = company },
                    )
                }

                if (selectedCompany != null) {
                    item {
                        Spacer(Modifier.height(20.dp))
                        Text("2. Package", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(8.dp))
                        if (packages.isEmpty()) {
                            Text(
                                "No packages available for this provider.",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                    items(packages, key = { it.id }) { pkg ->
                        PackageOption(
                            pkg = pkg,
                            selected = pkg.id == selectedPackage?.id,
                            onClick = { selectedPackage = pkg },
                        )
                    }
                }

                if (selectedPackage != null) {
                    item {
                        Spacer(Modifier.height(20.dp))
                        Text("3. Customer & payment", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = customerPhone,
                            onValueChange = { customerPhone = it },
                            label = { Text("Customer phone number") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = receiverPhone,
                            onValueChange = { receiverPhone = it },
                            label = { Text("Receiver number (if different)") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = paymentMethod,
                            onValueChange = { paymentMethod = it },
                            label = { Text("Payment method") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(16.dp))

                        if (error != null) {
                            Text(error!!, color = MaterialTheme.colorScheme.error)
                            Spacer(Modifier.height(8.dp))
                        }

                        Button(
                            onClick = {
                                error = null
                                submitting = true
                                scope.launch {
                                    try {
                                        val response = ApiClient.service.createSale(
                                            CreateSaleRequest(
                                                customerPhone = customerPhone.trim(),
                                                companyId = selectedCompany!!.id,
                                                packageId = selectedPackage!!.id,
                                                receiverPhone = receiverPhone.trim().ifBlank { null },
                                                paymentMethod = paymentMethod.trim().ifBlank { null },
                                            )
                                        )
                                        val order = response.body()
                                        if (response.isSuccessful && order != null) {
                                            success = order
                                        } else {
                                            error = "Couldn't create the sale — check the details and try again."
                                        }
                                    } catch (_: Exception) {
                                        error = "Network error while creating the sale."
                                    }
                                    submitting = false
                                }
                            },
                            enabled = customerPhone.isNotBlank() && !submitting,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(if (submitting) "Submitting..." else "Create Sale")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CompanyOption(company: Company, selected: Boolean, onClick: () -> Unit) {
    val offline = company.status == "offline"
    OutlinedCard(
        onClick = { if (!offline) onClick() },
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(company.name, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal)
            if (offline) Text("Offline", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
            else if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected")
        }
    }
}

@Composable
private fun PackageOption(pkg: PackageItem, selected: Boolean, onClick: () -> Unit) {
    OutlinedCard(onClick = onClick, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text(pkg.name, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal)
                Text(pkg.validity ?: "", style = MaterialTheme.typography.bodySmall)
            }
            Text("$${"%.2f".format(pkg.price)}", fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun SaleConfirmation(order: Order, onNewSale: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Sale created", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text("Order ${order.id}", style = MaterialTheme.typography.bodyLarge)
        Text("${order.companyName} · ${order.packageName}", style = MaterialTheme.typography.bodyMedium)
        Text("$${"%.2f".format(order.amount)}", style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(24.dp))
        Text(
            "This order is now pending — verify it from the Orders tab once payment comes in.",
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(20.dp))
        Button(onClick = onNewSale) { Text("Start another sale") }
    }
}
