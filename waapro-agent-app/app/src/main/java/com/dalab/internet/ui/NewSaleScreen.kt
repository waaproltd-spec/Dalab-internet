package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
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
import com.dalab.internet.util.companyKeyFromLabel
import com.dalab.internet.util.validateMobileNumber
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
fun NewSaleScreen(onBack: () -> Unit) {
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

    // Providers: loading -> list, or a clear error with Retry (never a blank screen).
    var companiesLoading by remember { mutableStateOf(true) }
    var companiesError by remember { mutableStateOf<String?>(null) }
    var companiesAttempt by remember { mutableStateOf(0) }
    LaunchedEffect(companiesAttempt) {
        companiesLoading = true
        companiesError = null
        try {
            val r = ApiClient.service.getCompanies()
            if (r.isSuccessful) companies = r.body().orEmpty()
            else companiesError = "Couldn't load providers (error ${r.code()})."
        } catch (_: Exception) {
            companiesError = "Couldn't load providers. Check your connection."
        }
        companiesLoading = false
    }
    var packagesLoading by remember { mutableStateOf(false) }

    LaunchedEffect(selectedCompany) {
        val company = selectedCompany
        selectedPackageIds = emptySet()
        paymentMethod = company?.gateway ?: ""
        if (company != null) {
            packagesLoading = true
            try {
                // Temporarily unavailable packages can't be sold (the server refuses them too).
                packages = ApiClient.service.getPackages(company.id).body().orEmpty().filter { it.ordersEnabled }
            } catch (_: Exception) {
                packages = emptyList()
            }
            packagesLoading = false
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

    Scaffold(
        topBar = {
            val step = when { successOrders != null -> 3; selectedPackageIds.isNotEmpty() -> 2; selectedCompany != null -> 1; else -> 0 }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(WaaproHeaderBrush, RoundedCornerShape(bottomStart = 26.dp, bottomEnd = 26.dp))
                    .padding(start = 8.dp, end = 16.dp, top = 10.dp, bottom = 18.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                    Text("New Sale", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp)
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(start = 8.dp)) {
                    listOf("Provider", "Packages", "Customer").forEachIndexed { i, label ->
                        SaleStep(i + 1, label, done = step > i, current = step == i, modifier = Modifier.weight(1f))
                    }
                }
            }
        },
    ) { padding ->
        val orders = successOrders
        if (orders != null) {
            SaleConfirmation(orders = orders, queuedPackages = queuedPackages, onNewSale = { reset() })
        } else {
            LazyColumn(
                modifier = Modifier.padding(padding).fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
            ) {
                if (syncState != PendingSalesSyncStatus.State.IDLE) {
                    item {
                        SyncStatusBanner(state = syncState, pendingCount = syncPendingCount)
                        Spacer(Modifier.height(12.dp))
                    }
                }
                item { SaleSectionTitle("Provider") }
                when {
                    companiesLoading && companies.isEmpty() -> item {
                        Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = WaaproNavy) }
                    }
                    companiesError != null && companies.isEmpty() -> item {
                        SaleNotice(companiesError!!, actionLabel = "Retry") { companiesAttempt++ }
                    }
                    companies.isEmpty() -> item { SaleNotice("No providers yet.", actionLabel = "Retry") { companiesAttempt++ } }
                    else -> items(companies.chunked(2), key = { row -> row.joinToString { it.id } }) { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                            row.forEach { company ->
                                CompanyOption(
                                    company = company,
                                    selected = company.id == selectedCompany?.id,
                                    onClick = { selectedCompany = company },
                                    modifier = Modifier.weight(1f),
                                )
                            }
                            if (row.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                }

                if (selectedCompany != null) {
                    item {
                        Spacer(Modifier.height(10.dp))
                        SaleSectionTitle("Packages")
                        if (packagesLoading) {
                            Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = WaaproNavy) }
                        } else if (packages.isEmpty()) {
                            SaleNotice("No packages for this provider.")
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
                        Spacer(Modifier.height(10.dp))
                        Surface(shape = RoundedCornerShape(18.dp), color = WaaproNavy, modifier = Modifier.fillMaxWidth()) {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    "${selectedPackageIds.size} package${if (selectedPackageIds.size == 1) "" else "s"}",
                                    color = Color.White.copy(alpha = 0.85f), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f),
                                )
                                Text("$${"%.2f".format(totalAmount)}", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp)
                            }
                        }

                        Spacer(Modifier.height(18.dp))
                        SaleSectionTitle("Customer")
                        // No company context for the customer's own number
                        // (any known carrier is accepted, same as
                        // registration) -- receiverPhone below is the SIM
                        // actually getting topped up, so it must belong to
                        // the selected provider's own carrier.
                        val customerPhoneError = if (customerPhone.isNotBlank()) validateMobileNumber(customerPhone.trim()).error else null
                        val receiverPhoneError = if (receiverPhone.isNotBlank()) {
                            validateMobileNumber(receiverPhone.trim(), selectedCompany?.let { companyKeyFromLabel(it.name) }).error
                        } else null
                        OutlinedTextField(
                            value = customerPhone,
                            onValueChange = { customerPhone = it },
                            label = { Text("Customer phone number") },
                            shape = RoundedCornerShape(14.dp),
                            singleLine = true,
                            isError = customerPhoneError != null,
                            supportingText = customerPhoneError?.let { { Text(it) } },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = receiverPhone,
                            onValueChange = { receiverPhone = it },
                            label = { Text("Receiver number (if different)") },
                            shape = RoundedCornerShape(14.dp),
                            singleLine = true,
                            isError = receiverPhoneError != null,
                            supportingText = receiverPhoneError?.let { { Text(it) } },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = paymentMethod,
                            onValueChange = { paymentMethod = it },
                            label = { Text("Payment method") },
                            shape = RoundedCornerShape(14.dp),
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
                            enabled = customerPhone.isNotBlank() && customerPhoneError == null && receiverPhoneError == null && !submitting,
                            colors = ButtonDefaults.buttonColors(containerColor = WaaproNavy),
                            shape = RoundedCornerShape(16.dp),
                            modifier = Modifier.fillMaxWidth().height(54.dp),
                        ) {
                            Text(
                                fontWeight = FontWeight.Bold,
                                text = 
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
private fun SaleStep(n: Int, label: String, done: Boolean, current: Boolean, modifier: Modifier) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = when { current -> WaaproGold; done -> Color.White.copy(alpha = 0.22f); else -> Color.White.copy(alpha = 0.10f) },
        modifier = modifier,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp)) {
            val ink = if (current) WaaproNavy else Color.White
            if (done) Icon(Icons.Filled.Check, contentDescription = null, tint = ink, modifier = Modifier.size(16.dp))
            else Text("$n", color = ink, fontWeight = FontWeight.ExtraBold, fontSize = 13.sp)
            Spacer(Modifier.width(6.dp))
            Text(label, color = ink, fontWeight = FontWeight.Bold, fontSize = 12.5.sp, maxLines = 1)
        }
    }
}

@Composable
private fun SaleSectionTitle(title: String) {
    Text(title, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp, modifier = Modifier.padding(start = 4.dp, bottom = 10.dp))
}

@Composable
private fun SaleNotice(text: String, actionLabel: String? = null, onAction: () -> Unit = {}) {
    Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth().border(1.dp, WaaproBorder, RoundedCornerShape(18.dp))) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Text(text, color = WaaproMuted, modifier = Modifier.weight(1f))
            if (actionLabel != null) TextButton(onClick = onAction) { Text(actionLabel, fontWeight = FontWeight.Bold) }
        }
    }
}

private fun saleColor(hex: String?, fallback: Color): Color =
    try { hex?.let { Color(android.graphics.Color.parseColor(it)) } ?: fallback } catch (_: Exception) { fallback }

/** A provider tile: its colour, its name, a tick when chosen; greyed when offline. */
@Composable
private fun CompanyOption(company: Company, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val offline = company.status == "offline"
    val brand = saleColor(company.colorHex, WaaproBlue)
    Surface(
        shape = RoundedCornerShape(18.dp),
        color = if (selected) brand.copy(alpha = 0.10f) else MaterialTheme.colorScheme.surface,
        shadowElevation = if (selected) 0.dp else 1.dp,
        modifier = modifier
            .height(72.dp)
            .border(if (selected) 2.dp else 1.dp, if (selected) brand else WaaproBorder, RoundedCornerShape(18.dp))
            .clip(RoundedCornerShape(18.dp))
            .clickable(enabled = !offline, onClick = onClick),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 12.dp)) {
            Box(
                Modifier.size(38.dp).clip(CircleShape).background(if (offline) WaaproBorder else brand),
                contentAlignment = Alignment.Center,
            ) { Text((company.name.firstOrNull() ?: '?').uppercase(), color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp) }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(company.name, fontWeight = FontWeight.Bold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (offline) WaaproMuted else Color.Unspecified)
                if (offline) Text("Offline", color = Color(0xFFDC2626), fontSize = 11.sp)
            }
            if (selected) Icon(Icons.Filled.CheckCircle, contentDescription = "Selected", tint = brand, modifier = Modifier.size(20.dp))
        }
    }
}

/** A package to tick: name, validity, price. */
@Composable
private fun PackageOption(pkg: PackageItem, selected: Boolean, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(18.dp),
        color = if (selected) WaaproNavy.copy(alpha = 0.06f) else MaterialTheme.colorScheme.surface,
        shadowElevation = if (selected) 0.dp else 1.dp,
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 10.dp)
            .border(if (selected) 2.dp else 1.dp, if (selected) WaaproNavy else WaaproBorder, RoundedCornerShape(18.dp))
            .clip(RoundedCornerShape(18.dp))
            .clickable(onClick = onClick),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
            Box(
                Modifier.size(26.dp).clip(CircleShape)
                    .background(if (selected) WaaproNavy else Color.Transparent)
                    .border(2.dp, if (selected) WaaproNavy else WaaproBorder, CircleShape),
                contentAlignment = Alignment.Center,
            ) { if (selected) Icon(Icons.Filled.Check, contentDescription = null, tint = Color.White, modifier = Modifier.size(16.dp)) }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(pkg.name, fontWeight = FontWeight.Bold, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                pkg.validity?.takeIf { it.isNotBlank() }?.let { Text(it, color = WaaproMuted, fontSize = 12.5.sp) }
            }
            Spacer(Modifier.width(8.dp))
            Text("$${"%.2f".format(pkg.price)}", fontWeight = FontWeight.ExtraBold, color = Color(0xFF137A3A), fontSize = 17.sp)
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
        Button(onClick = onNewSale, colors = ButtonDefaults.buttonColors(containerColor = WaaproNavy), shape = RoundedCornerShape(16.dp)) { Text("Start another sale", fontWeight = FontWeight.Bold) }
    }
}

@Composable
private fun SyncStatusBanner(state: PendingSalesSyncStatus.State, pendingCount: Int) {
    val (bg, fg, label) = when (state) {
        PendingSalesSyncStatus.State.OFFLINE -> Triple(
            Color(0xFFFFF3CD), Color(0xFF7A5B00),
            "Offline — $pendingCount sale${if (pendingCount == 1) "" else "s"} waiting to send",
        )
        // Functional "in progress" status color, not brand — was the old
        // Dalab Indigo hex coincidentally, now the same info-blue the
        // Customer App/Admin Dashboard use for status (not Dark Azure,
        // which is reserved for actual brand elements).
        PendingSalesSyncStatus.State.SYNCING -> Triple(
            Color(0xFFD6E4FF), Color(0xFF1D4ED8),
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
