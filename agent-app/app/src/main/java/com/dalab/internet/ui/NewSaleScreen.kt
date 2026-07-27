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
import java.util.UUID

/**
 * Agent-initiated sale for a walk-in customer: pick a provider, pick one or
 * more packages for that same customer (bulk multi-package purchase — e.g. a
 * data bundle plus a voice bundle in one visit), enter the customer's phone
 * (and payment method), submit. Each selected package becomes its own order
 * via POST /agent/orders (there's no batch-create endpoint; the backend's
 * per-order idempotency key already makes looping here safe to retry), which
 * looks up or creates the customer by phone the same way OTP verify does for
 * the Customer App.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewSaleScreen() {
    var companies by remember { mutableStateOf<List<Company>>(emptyList()) }
    var selectedCompany by remember { mutableStateOf<Company?>(null) }
    var packages by remember { mutableStateOf<List<PackageItem>>(emptyList()) }
    var selectedPackageIds by remember { mutableStateOf(setOf<String>()) }
    var customerPhone by remember { mutableStateOf("") }
    var receiverPhone by remember { mutableStateOf("") }
    var paymentMethod by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var successOrders by remember { mutableStateOf<List<Order>?>(null) }
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
        selectedPackageIds = emptySet()
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
        selectedPackageIds = emptySet()
        customerPhone = ""
        receiverPhone = ""
        paymentMethod = ""
        successOrders = null
        error = null
    }

    val selectedPackages = packages.filter { selectedPackageIds.contains(it.id) }
    val totalAmount = selectedPackages.sumOf { it.price }

    Scaffold(topBar = { TopAppBar(title = { Text("New Sale") }) }) { padding ->
        val orders = successOrders
        if (orders != null) {
            SaleConfirmation(orders = orders, onNewSale = { reset() })
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
                        Text("2. Packages (select one or more)", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
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
                            selected = selectedPackageIds.contains(pkg.id),
                            onClick = {
                                selectedPackageIds = if (selectedPackageIds.contains(pkg.id)) {
                                    selectedPackageIds - pkg.id
                                } else {
                                    selectedPackageIds + pkg.id
                                }
                            },
                        )
                    }
                }

                if (selectedPackageIds.isNotEmpty()) {
                    item {
                        Spacer(Modifier.height(12.dp))
                        Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium) {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(12.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text("${selectedPackageIds.size} package${if (selectedPackageIds.size == 1) "" else "s"} selected")
                                Text("$${"%.2f".format(totalAmount)} total", fontWeight = FontWeight.Bold)
                            }
                        }

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
                                    val created = mutableListOf<Order>()
                                    var failure: String? = null
                                    for (pkg in selectedPackages) {
                                        try {
                                            val response = ApiClient.service.createSale(
                                                CreateSaleRequest(
                                                    customerPhone = customerPhone.trim(),
                                                    companyId = selectedCompany!!.id,
                                                    packageId = pkg.id,
                                                    receiverPhone = receiverPhone.trim().ifBlank { null },
                                                    paymentMethod = paymentMethod.trim().ifBlank { null },
                                                    // One idempotency key per package, not shared across the
                                                    // batch — each package is its own order, so collapsing
                                                    // them under one key would dedup all but the first.
                                                    clientRequestId = UUID.randomUUID().toString(),
                                                )
                                            )
                                            val order = response.body()
                                            if (response.isSuccessful && order != null) {
                                                created += order
                                            } else {
                                                failure = "Couldn't create a sale for ${pkg.name} — stopped after ${created.size} of ${selectedPackages.size}."
                                                break
                                            }
                                        } catch (_: Exception) {
                                            failure = "Network error while creating a sale for ${pkg.name} — stopped after ${created.size} of ${selectedPackages.size}."
                                            break
                                        }
                                    }
                                    if (created.isNotEmpty()) {
                                        successOrders = created
                                    } else {
                                        error = failure ?: "Couldn't create the sale — check the details and try again."
                                    }
                                    submitting = false
                                }
                            },
                            enabled = customerPhone.isNotBlank() && !submitting,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                if (submitting) "Submitting..."
                                else if (selectedPackageIds.size > 1) "Create ${selectedPackageIds.size} Sales"
                                else "Create Sale"
                            )
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
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = selected, onCheckedChange = { onClick() })
                Column {
                    Text(pkg.name, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal)
                    Text(pkg.validity ?: "", style = MaterialTheme.typography.bodySmall)
                }
            }
            Text("$${"%.2f".format(pkg.price)}", fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun SaleConfirmation(orders: List<Order>, onNewSale: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            if (orders.size > 1) "${orders.size} sales created" else "Sale created",
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(12.dp))
        orders.forEach { order ->
            Text("Order ${order.id}", style = MaterialTheme.typography.bodyLarge)
            Text("${order.companyName} · ${order.packageName} · $${"%.2f".format(order.amount)}", style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(8.dp))
        }
        Spacer(Modifier.height(16.dp))
        Text(
            "These orders are now pending — verify them from the Orders tab once payment comes in.",
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(20.dp))
        Button(onClick = onNewSale) { Text("Start another sale") }
    }
}
