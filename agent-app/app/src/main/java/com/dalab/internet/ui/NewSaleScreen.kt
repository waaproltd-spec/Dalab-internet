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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import com.dalab.internet.data.Company
import com.dalab.internet.data.Order
import com.dalab.internet.data.PackageItem
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.CreateSaleRequest
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.queue.PendingSalesSyncStatus
import com.dalab.internet.queue.RetryClassifier
import com.dalab.internet.queue.SaleCreateAction
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
    var queuedPackages by remember { mutableStateOf<List<PackageItem>>(emptyList()) }
    val scope = rememberCoroutineScope()
    val syncState by PendingSalesSyncStatus.state.collectAsState()
    val syncPendingCount by PendingSalesSyncStatus.pendingCount.collectAsState()

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
        queuedPackages = emptyList()
        error = null
    }

    val selectedPackages = packages.filter { selectedPackageIds.contains(it.id) }
    val totalAmount = selectedPackages.sumOf { it.price }

    Scaffold(topBar = { TopAppBar(title = { Text("New Sale") }) }) { padding ->
        val orders = successOrders
        if (orders != null) {
            SaleConfirmation(orders = orders, queuedPackages = queuedPackages, onNewSale = { reset() })
        } else {
            LazyColumn(modifier = Modifier.padding(padding).fillMaxSize().padding(16.dp)) {
                if (syncState != PendingSalesSyncStatus.State.IDLE) {
                    item {
                        SyncStatusBanner(state = syncState, pendingCount = syncPendingCount)
                        Spacer(Modifier.height(12.dp))
                    }
                }
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
                                    val queued = mutableListOf<PackageItem>()
                                    var failure: String? = null
                                    // Once one package in this batch fails for a
                                    // connectivity reason, every remaining package
                                    // would fail identically — queue the rest
                                    // immediately instead of hammering the network
                                    // once per package only to get the same result.
                                    var offlineFromHereOn = false
                                    for (pkg in selectedPackages) {
                                        val request = CreateSaleRequest(
                                            customerPhone = customerPhone.trim(),
                                            companyId = selectedCompany!!.id,
                                            packageId = pkg.id,
                                            receiverPhone = receiverPhone.trim().ifBlank { null },
                                            paymentMethod = paymentMethod.trim().ifBlank { null },
                                            // One idempotency key per package, not shared across the
                                            // batch — each package is its own order, so collapsing
                                            // them under one key would dedup all but the first. This
                                            // same id is reused if the request has to be queued and
                                            // replayed later, so a retry can never create a duplicate.
                                            clientRequestId = UUID.randomUUID().toString(),
                                        )
                                        if (offlineFromHereOn) {
                                            PendingActionQueue.enqueueIfAbsent(
                                                request.clientRequestId!!, PendingActionQueue.Type.SALE_CREATE, SaleCreateAction(request, pkg.name),
                                            )
                                            queued += pkg
                                            continue
                                        }
                                        try {
                                            val response = RetryClassifier.requireSuccessful(ApiClient.service.createSale(request))
                                            val order = response.body()
                                            if (order != null) {
                                                created += order
                                            } else {
                                                failure = "Couldn't create a sale for ${pkg.name} — stopped after ${created.size} of ${selectedPackages.size}."
                                                break
                                            }
                                        } catch (e: Exception) {
                                            if (RetryClassifier.isRetryable(e)) {
                                                PendingActionQueue.enqueueIfAbsent(
                                                    request.clientRequestId!!, PendingActionQueue.Type.SALE_CREATE, SaleCreateAction(request, pkg.name),
                                                )
                                                queued += pkg
                                                offlineFromHereOn = true
                                                PendingSalesSyncStatus.markQueued()
                                            } else {
                                                failure = "Couldn't create a sale for ${pkg.name} — stopped after ${created.size} of ${selectedPackages.size}."
                                                break
                                            }
                                        }
                                    }
                                    if (failure != null) {
                                        error = failure
                                    } else if (created.isNotEmpty() || queued.isNotEmpty()) {
                                        successOrders = created
                                        queuedPackages = queued
                                    } else {
                                        error = "Couldn't create the sale — check the details and try again."
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
private fun SaleConfirmation(orders: List<Order>, queuedPackages: List<PackageItem>, onNewSale: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (orders.isNotEmpty()) {
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
        }
        if (queuedPackages.isNotEmpty()) {
            if (orders.isNotEmpty()) Spacer(Modifier.height(20.dp))
            Surface(color = Color(0xFFFFF3CD), shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        "You're offline — ${queuedPackages.size} sale${if (queuedPackages.size == 1) "" else "s"} queued",
                        fontWeight = FontWeight.Bold,
                        color = Color(0xFF7A5B00),
                    )
                    Spacer(Modifier.height(4.dp))
                    queuedPackages.forEach { pkg -> Text("• ${pkg.name}", color = Color(0xFF7A5B00)) }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "These will be sent automatically, one at a time, the moment this device reconnects.",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFF7A5B00),
                    )
                }
            }
        }
        Spacer(Modifier.height(20.dp))
        Button(onClick = onNewSale) { Text("Start another sale") }
    }
}

@Composable
private fun SyncStatusBanner(state: PendingSalesSyncStatus.State, pendingCount: Int) {
    val (bg, fg, label) = when (state) {
        PendingSalesSyncStatus.State.OFFLINE -> Triple(
            Color(0xFFFFF3CD), Color(0xFF7A5B00),
            "Offline — $pendingCount sale${if (pendingCount == 1) "" else "s"} waiting to send",
        )
        PendingSalesSyncStatus.State.SYNCING -> Triple(
            Color(0xFFD6E4FF), Color(0xFF1D2E8C),
            "Syncing $pendingCount pending sale${if (pendingCount == 1) "" else "s"}…",
        )
        PendingSalesSyncStatus.State.COMPLETED -> Triple(
            Color(0xFFDCFCE7), Color(0xFF16A34A),
            "All pending sales synced",
        )
        PendingSalesSyncStatus.State.IDLE -> return
    }
    Surface(color = bg, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state == PendingSalesSyncStatus.State.SYNCING) {
                CircularProgressIndicator(color = fg, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(10.dp))
            }
            Text(label, color = fg, fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodySmall)
        }
    }
}
