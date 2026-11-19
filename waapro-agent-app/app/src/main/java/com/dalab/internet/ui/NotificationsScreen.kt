package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Message
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.sp
import com.dalab.internet.data.CustomerSummary
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.BroadcastRequest
import com.dalab.internet.network.BroadcastResponse
import com.dalab.internet.network.NotificationCampaign
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private data class TargetOption(val value: String, val label: String, val icon: ImageVector)

private val TARGET_TYPES = listOf(
    TargetOption("single", "One customer", Icons.Filled.Person),
    TargetOption("multiple", "Selected", Icons.Filled.Group),
    TargetOption("all", "All customers", Icons.Filled.Groups),
    TargetOption("recent", "New (7 days)", Icons.Filled.Schedule),
)
private val SERVICE_FILTERS = listOf("all" to "All Services", "internet" to "Internet", "ebadal" to "eBadal", "reseller" to "Reseller")

private fun targetLabel(value: String) = TARGET_TYPES.firstOrNull { it.value == value }?.label ?: value
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
    // When: now, or at a set date and time (Mogadishu).
    var scheduleOn by remember { mutableStateOf(false) }
    var everyDay by remember { mutableStateOf(false) }
    val defaultAt = remember { java.time.ZonedDateTime.now(MOGADISHU).plusMinutes(30).withSecond(0).withNano(0) }
    var day by remember { mutableStateOf(defaultAt.toLocalDate()) }
    var time by remember { mutableStateOf(defaultAt.toLocalTime()) }
    var pickDay by remember { mutableStateOf(false) }
    var pickTime by remember { mutableStateOf(false) }
    var requestId by remember { mutableStateOf(java.util.UUID.randomUUID().toString()) }
    var cancelling by remember { mutableStateOf<NotificationCampaign?>(null) }

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
    // While a message is being sent or waits for its time, keep the history fresh.
    LaunchedEffect(campaigns) {
        if (campaigns.any { it.status == "sending" || it.status == "scheduled" }) {
            delay(15_000L)
            try {
                val response = ApiClient.service.getNotificationCampaigns()
                if (response.isSuccessful) campaigns = response.body().orEmpty()
            } catch (_: Exception) {
            }
        }
    }

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
                        scheduledAt = if (scheduleOn) java.time.ZonedDateTime.of(day, time, MOGADISHU).toInstant().toString() else null,
                        requestId = requestId,
                        repeat = if (scheduleOn && everyDay) "daily" else null,
                    )
                )
                if (response.isSuccessful && response.body() != null) {
                    sendResult = response.body()
                    requestId = java.util.UUID.randomUUID().toString()
                    scheduleOn = false
                    everyDay = false
                    title = ""
                    body = ""
                    selectedCustomers = emptyList()
                    customerSearch = ""
                    fetchHistory()
                } else {
                    sendError = try {
                        response.errorBody()?.string()?.let { org.json.JSONObject(it).optString("error").takeIf { e -> e.isNotBlank() } }
                    } catch (_: Exception) { null } ?: "Could not send notification."
                }
            } catch (_: Exception) {
                // Tapping Send again is safe: the same request id never sends twice.
                sendError = "No answer from the server. Check Sent history before sending again."
                fetchHistory()
            }
            sending = false
        }
    }

    Scaffold(
        topBar = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(WaaproHeaderBrush, RoundedCornerShape(bottomStart = 26.dp, bottomEnd = 26.dp))
                    .padding(start = 8.dp, end = 16.dp, top = 14.dp, bottom = 18.dp),
            ) {
                IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                Text("Notifications", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp, modifier = Modifier.weight(1f))
                Box(
                    modifier = Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(Color.White.copy(alpha = 0.16f)),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Filled.Campaign, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp)) }
            }
        }
    ) { padding ->
        LazyColumn(modifier = Modifier.padding(padding).fillMaxSize().padding(horizontal = 16.dp)) {
            item {
                Spacer(Modifier.height(12.dp))
                Text("Send to", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                TargetOptionGrid(targetType) { targetType = it; selectedCustomers = emptyList() }
                Spacer(Modifier.height(12.dp))
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
                Text("Service", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                var serviceMenuExpanded by remember { mutableStateOf(false) }
                ExposedDropdownMenuBox(expanded = serviceMenuExpanded, onExpandedChange = { serviceMenuExpanded = it }) {
                    OutlinedTextField(
                        value = serviceLabel(serviceFilter),
                        onValueChange = {},
                        readOnly = true,
                        leadingIcon = { Icon(Icons.Filled.Apps, contentDescription = null) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = serviceMenuExpanded) },
                        shape = RoundedCornerShape(14.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            unfocusedContainerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f),
                            focusedContainerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f),
                            unfocusedBorderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.25f),
                        ),
                        modifier = Modifier.menuAnchor().fillMaxWidth(),
                    )
                    ExposedDropdownMenu(expanded = serviceMenuExpanded, onDismissRequest = { serviceMenuExpanded = false }) {
                        SERVICE_FILTERS.forEach { (value, label) ->
                            DropdownMenuItem(text = { Text(label) }, onClick = { serviceFilter = value; serviceMenuExpanded = false })
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))

                Text("Title", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    placeholder = { Text("Title") },
                    leadingIcon = { Icon(Icons.Filled.Description, contentDescription = null) },
                    singleLine = true,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))

                Text("Message", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                OutlinedTextField(
                    value = body,
                    onValueChange = { if (it.length <= 500) body = it },
                    placeholder = { Text("Message") },
                    leadingIcon = { Icon(Icons.Filled.Message, contentDescription = null) },
                    minLines = 2,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "${body.length}/500",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp, end = 4.dp),
                    textAlign = TextAlign.End,
                )
                Spacer(Modifier.height(12.dp))

                Text("When", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    FilterChip(selected = !scheduleOn, onClick = { scheduleOn = false }, label = { Text("Send now") })
                    FilterChip(
                        selected = scheduleOn,
                        onClick = { scheduleOn = true },
                        label = { Text("Schedule") },
                        leadingIcon = { Icon(Icons.Filled.Schedule, contentDescription = null, modifier = Modifier.size(18.dp)) },
                    )
                }
                if (scheduleOn) {
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(onClick = { pickDay = true }, modifier = Modifier.weight(1f), shape = RoundedCornerShape(14.dp)) {
                            Text(day.format(java.time.format.DateTimeFormatter.ofPattern("dd/MM/yyyy")))
                        }
                        OutlinedButton(onClick = { pickTime = true }, modifier = Modifier.weight(1f), shape = RoundedCornerShape(14.dp)) {
                            Text(time.format(java.time.format.DateTimeFormatter.ofPattern("h:mm a")))
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    FilterChip(
                        selected = everyDay,
                        onClick = { everyDay = !everyDay },
                        label = { Text("Every day") },
                        leadingIcon = { Icon(Icons.Filled.Repeat, contentDescription = null, modifier = Modifier.size(18.dp)) },
                    )
                    Text(
                        if (everyDay) "Sent every day at this time (Mogadishu), starting on the chosen day. Cancel it in Sent history to stop."
                        else "Mogadishu time. You can cancel it in Sent history until it goes out.",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
                Spacer(Modifier.height(16.dp))

                if (sendError != null) {
                    Text(sendError!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(8.dp))
                }
                sendResult?.let { result ->
                    val who = "${result.recipientCount} customer${if (result.recipientCount == 1) "" else "s"}"
                    Text(
                        when (result.status) {
                            "scheduled" -> if (result.repeat == "daily") "Scheduled every day from ${scheduleTimeText(result.scheduledAt)} — $who."
                                else "Scheduled for ${scheduleTimeText(result.scheduledAt)} — $who."
                            "sending" -> "Sending to $who. Sent history shows the progress."
                            else -> "Sent to $who — ${result.deliveredCount} delivered, ${result.failedCount} failed."
                        },
                        color = MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Spacer(Modifier.height(8.dp))
                }

                Button(
                    onClick = ::send,
                    enabled = canSend,
                    shape = RoundedCornerShape(50),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) {
                    Icon(Icons.Filled.Send, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(if (sending) "Sending..." else if (scheduleOn) "Schedule notification" else "Send notification", fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.height(24.dp))

                Divider()
                Spacer(Modifier.height(16.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier.size(40.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(MaterialTheme.colorScheme.primaryContainer),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Filled.History,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text("Sent history", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text(
                            "View your previously sent notifications",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Spacer(Modifier.height(12.dp))
            }

            if (historyError != null) {
                item { Text(historyError!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            } else if (loadingHistory) {
                item { Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
            } else if (campaigns.isEmpty()) {
                item { Text("Nothing sent yet.", style = MaterialTheme.typography.bodySmall) }
            } else {
                items(campaigns, key = { it.id }) { campaign -> CampaignRow(campaign, onCancel = { cancelling = campaign }) }
            }

            item { Spacer(Modifier.height(24.dp)) }
        }
    }

    if (pickDay) {
        val utcMillis = day.atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli()
        val state = rememberDatePickerState(initialSelectedDateMillis = utcMillis)
        DatePickerDialog(
            onDismissRequest = { pickDay = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { day = java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneOffset.UTC).toLocalDate() }
                    pickDay = false
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { pickDay = false }) { Text("Cancel") } },
        ) { DatePicker(state = state) }
    }
    if (pickTime) {
        val state = rememberTimePickerState(initialHour = time.hour, initialMinute = time.minute, is24Hour = false)
        AlertDialog(
            onDismissRequest = { pickTime = false },
            title = { Text("Send time (Mogadishu)") },
            text = { TimePicker(state = state) },
            confirmButton = { TextButton(onClick = { time = java.time.LocalTime.of(state.hour, state.minute); pickTime = false }) { Text("OK") } },
            dismissButton = { TextButton(onClick = { pickTime = false }) { Text("Cancel") } },
        )
    }
    cancelling?.let { c ->
        AlertDialog(
            onDismissRequest = { cancelling = null },
            title = { Text("Cancel this message?") },
            text = { Text(if (c.repeat == "daily") "\"${c.title}\" will stop: no more daily sends." else "\"${c.title}\" will not be sent.") },
            confirmButton = {
                TextButton(onClick = {
                    cancelling = null
                    scope.launch {
                        try {
                            val r = ApiClient.service.cancelNotificationCampaign(c.id)
                            if (!r.isSuccessful) historyError = "Could not cancel: it may already have been sent."
                        } catch (_: Exception) {
                            historyError = "Could not cancel. Check your connection."
                        }
                        fetchHistory()
                    }
                }) { Text("Cancel message", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { cancelling = null }) { Text("Keep") } },
        )
    }
}

@Composable
private fun TargetOptionGrid(selected: String, onSelect: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (row in TARGET_TYPES.chunked(2)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { option ->
                    TargetOptionCard(
                        option = option,
                        selected = selected == option.value,
                        onClick = { onSelect(option.value) },
                        modifier = Modifier.weight(1f),
                    )
                }
                // The last row may have only one card (4 options, 2 per row --
                // always even here, but this keeps the grid honest if a third
                // row or an odd option count is ever added).
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun TargetOptionCard(option: TargetOption, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(14.dp),
        color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
        border = BorderStroke(
            1.dp,
            if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
        ),
        modifier = modifier,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                option.icon,
                contentDescription = null,
                tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                option.label,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
            )
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
private fun CampaignRow(campaign: NotificationCampaign, onCancel: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        when (campaign.status) {
            "scheduled" -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text(
                    (if (campaign.repeat == "daily") "Every day · next " else "Scheduled · ") + scheduleTimeText(campaign.scheduledAt),
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onCancel) { Text("Cancel", color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Bold) }
            }
            "sending" -> Text("Sending…", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium)
            "cancelled" -> Text(if (campaign.repeat == "daily") "Daily message stopped" else "Cancelled", color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium)
            else -> {}
        }
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
