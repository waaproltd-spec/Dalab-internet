package com.dalab.internet.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.CustomerSummary
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.BroadcastRequest
import com.dalab.internet.network.BroadcastResponse
import com.dalab.internet.network.NotificationCampaign
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val TARGET_TYPES = listOf("single" to "One customer", "multiple" to "Selected customers", "all" to "All customers", "recent" to "Joined in last 7 days")
private val SERVICE_FILTERS = listOf("all" to "All Services", "internet" to "Internet", "ebadal" to "eBadal", "reseller" to "Reseller")

private fun targetLabel(value: String) = TARGET_TYPES.firstOrNull { it.first == value }?.second ?: value
private fun serviceLabel(value: String) = SERVICE_FILTERS.firstOrNull { it.first == value }?.second ?: value

/**
 * The exact same broadcast composer + history the Admin dashboard's
 * Notifications tab has (same POST /notifications/broadcast +
 * GET /notifications/campaigns routes, same target/service options) — an
 * agent can send the identical push notifications an admin can, per spec.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationsScreen(onBack: () -> Unit) {
    var targetType by remember { mutableStateOf("all") }
    var serviceFilter by remember { mutableStateOf("all") }
    var selectedCustomers by remember { mutableStateOf<List<CustomerSummary>>(emptyList()) }
    var customerSearch by remember { mutableStateOf("") }
    var customerResults by remember { mutableStateOf<List<CustomerSummary>>(emptyList()) }
    var searchingCustomers by remember { mutableStateOf(false) }
    var title by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var sendError by remember { mutableStateOf<String?>(null) }
    var sendResult by remember { mutableStateOf<BroadcastResponse?>(null) }

    var campaigns by remember { mutableStateOf<List<NotificationCampaign>>(emptyList()) }
    var loadingHistory by remember { mutableStateOf(true) }
    var historyError by remember { mutableStateOf<String?>(null) }

    val scope = rememberCoroutineScope()

    fun fetchHistory() {
        loadingHistory = true
        historyError = null
        scope.launch {
            try {
                val response = ApiClient.service.getNotificationCampaigns()
                if (response.isSuccessful) campaigns = response.body().orEmpty()
                else historyError = "Could not load sent history."
            } catch (_: Exception) {
                historyError = "Could not load sent history. Check your connection."
            }
            loadingHistory = false
        }
    }
    LaunchedEffect(Unit) { fetchHistory() }

    // Debounced customer search, same 300ms debounce the Admin dashboard uses.
    LaunchedEffect(customerSearch, targetType) {
        if (targetType != "single" && targetType != "multiple") return@LaunchedEffect
        if (customerSearch.isBlank()) { customerResults = emptyList(); return@LaunchedEffect }
        searchingCustomers = true
        delay(300)
        try {
            val response = ApiClient.service.getCustomers(customerSearch.trim())
            customerResults = response.body().orEmpty()
        } catch (_: Exception) {
            customerResults = emptyList()
        }
        searchingCustomers = false
    }

    fun toggleCustomer(customer: CustomerSummary) {
        val already = selectedCustomers.any { it.id == customer.id }
        selectedCustomers = when {
            already -> selectedCustomers.filter { it.id != customer.id }
            targetType == "single" -> listOf(customer)
            else -> selectedCustomers + customer
        }
    }

    val canSend = title.isNotBlank() && body.isNotBlank() && !sending &&
        ((targetType != "single" && targetType != "multiple") || selectedCustomers.isNotEmpty())

    fun send() {
        if (!canSend) return
        sending = true
        sendError = null
        sendResult = null
        scope.launch {
            try {
                val response = ApiClient.service.broadcastNotification(
                    BroadcastRequest(
                        targetType = targetType,
                        customerIds = selectedCustomers.map { it.id },
                        serviceFilter = serviceFilter,
                        title = title.trim(),
                        body = body.trim(),
                    )
                )
                if (response.isSuccessful && response.body() != null) {
                    sendResult = response.body()
                    title = ""
                    body = ""
                    selectedCustomers = emptyList()
                    customerSearch = ""
                    fetchHistory()
                } else {
                    sendError = "Could not send notification."
                }
            } catch (_: Exception) {
                sendError = "Could not send notification. Check your connection."
            }
            sending = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Notifications") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        }
    ) { padding ->
        LazyColumn(modifier = Modifier.padding(padding).fillMaxSize().padding(horizontal = 16.dp)) {
            item {
                Spacer(Modifier.height(12.dp))
                Text("Send to", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
                FlowRowTargets(targetType) { targetType = it; selectedCustomers = emptyList() }
                Spacer(Modifier.height(16.dp))
            }

            if (targetType == "single" || targetType == "multiple") {
                item {
                    Text(if (targetType == "single") "Customer" else "Customers", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(8.dp))
                    if (selectedCustomers.isNotEmpty()) {
                        FlowRowChips(selectedCustomers, onRemove = ::toggleCustomer)
                        Spacer(Modifier.height(8.dp))
                    }
                    OutlinedTextField(
                        value = customerSearch,
                        onValueChange = { customerSearch = it },
                        label = { Text("Search by name or phone") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(4.dp))
                    if (customerSearch.isNotBlank()) {
                        if (searchingCustomers) {
                            Text("Searching…", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(8.dp))
                        } else if (customerResults.isEmpty()) {
                            Text("No matching customers.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(8.dp))
                        } else {
                            Column {
                                customerResults.forEach { customer ->
                                    val checked = selectedCustomers.any { it.id == customer.id }
                                    ListItem(
                                        headlineContent = { Text(customer.name?.takeIf { it.isNotBlank() } ?: customer.phone) },
                                        supportingContent = { Text(customer.phone) },
                                        trailingContent = { if (checked) Icon(Icons.Filled.Close, contentDescription = "Remove", tint = MaterialTheme.colorScheme.primary) },
                                        modifier = Modifier.clickable { toggleCustomer(customer) },
                                    )
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(16.dp))
                }
            }

            item {
                Text("Service", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
                var serviceMenuExpanded by remember { mutableStateOf(false) }
                ExposedDropdownMenuBox(expanded = serviceMenuExpanded, onExpandedChange = { serviceMenuExpanded = it }) {
                    OutlinedTextField(
                        value = serviceLabel(serviceFilter),
                        onValueChange = {},
                        readOnly = true,
                        modifier = Modifier.menuAnchor().fillMaxWidth(),
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = serviceMenuExpanded) },
                    )
                    ExposedDropdownMenu(expanded = serviceMenuExpanded, onDismissRequest = { serviceMenuExpanded = false }) {
                        SERVICE_FILTERS.forEach { (value, label) ->
                            DropdownMenuItem(text = { Text(label) }, onClick = { serviceFilter = value; serviceMenuExpanded = false })
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))

                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("Title") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = body,
                    onValueChange = { body = it },
                    label = { Text("Message") },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))

                if (sendError != null) {
                    Text(sendError!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(8.dp))
                }
                sendResult?.let { result ->
                    Text(
                        "Sent to ${result.recipientCount} customer${if (result.recipientCount == 1) "" else "s"} — ${result.deliveredCount} delivered, ${result.failedCount} failed.",
                        color = MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Spacer(Modifier.height(8.dp))
                }

                Button(onClick = ::send, enabled = canSend, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Filled.Campaign, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(if (sending) "Sending..." else "Send notification")
                }
                Spacer(Modifier.height(24.dp))

                Divider()
                Spacer(Modifier.height(12.dp))
                Text("Sent history", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
            }

            if (historyError != null) {
                item { Text(historyError!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            } else if (loadingHistory) {
                item { Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
            } else if (campaigns.isEmpty()) {
                item { Text("Nothing sent yet.", style = MaterialTheme.typography.bodySmall) }
            } else {
                items(campaigns, key = { it.id }) { campaign -> CampaignRow(campaign) }
            }

            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun FlowRowTargets(selected: String, onSelect: (String) -> Unit) {
    Column {
        for (row in TARGET_TYPES.chunked(2)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { (value, label) ->
                    FilterChip(
                        selected = selected == value,
                        onClick = { onSelect(value) },
                        label = { Text(label) },
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

@Composable
private fun FlowRowChips(customers: List<CustomerSummary>, onRemove: (CustomerSummary) -> Unit) {
    Column {
        for (row in customers.chunked(2)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                row.forEach { customer ->
                    AssistChip(
                        onClick = { onRemove(customer) },
                        label = { Text(customer.name?.takeIf { it.isNotBlank() } ?: customer.phone) },
                        trailingIcon = { Icon(Icons.Filled.Close, contentDescription = "Remove", modifier = Modifier.size(16.dp)) },
                    )
                }
            }
            Spacer(Modifier.height(6.dp))
        }
    }
}

@Composable
private fun CampaignRow(campaign: NotificationCampaign) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.weight(1f)) {
                Text(campaign.title, fontWeight = FontWeight.Bold)
                Text(campaign.body, style = MaterialTheme.typography.bodySmall, maxLines = 2)
            }
            AssistChip(onClick = {}, label = { Text(targetLabel(campaign.targetType)) })
        }
        Spacer(Modifier.height(4.dp))
        val roleLabel = if (campaign.createdByRole == "agent") "Agent" else "Admin"
        Text(
            "${campaign.createdByName ?: "—"} ($roleLabel) · ${serviceLabel(campaign.serviceFilter)}",
            style = MaterialTheme.typography.labelSmall,
        )
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            AssistChip(onClick = {}, label = { Text("${campaign.recipientCount} sent") })
            AssistChip(onClick = {}, label = { Text("${campaign.deliveredCount} delivered") })
            AssistChip(onClick = {}, label = { Text("${campaign.failedCount} failed") })
        }
        Divider(modifier = Modifier.padding(top = 10.dp))
    }
}
