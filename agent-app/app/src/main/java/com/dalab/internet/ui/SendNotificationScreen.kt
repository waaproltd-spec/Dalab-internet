package com.dalab.internet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.SendCustomerNotificationRequest
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.launch

private enum class CustomerNotificationType(val apiValue: String, val label: String) {
    PUSH("push", "Update"),
    PROMOTION("promotion", "Promotion / Offer"),
}

/**
 * Agent App equivalent of the Admin Dashboard's Notifications page —
 * announce something to every customer (a new update, cheaper packages,
 * a promotion, a service notice) through the same POST
 * /admin/notifications/send endpoint/logic Admin already uses, just fixed
 * to targetType="all" (also enforced server-side for the "agent" role).
 * Customers see it in the Customer App's notifications inbox exactly as
 * they would an Admin-sent one.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SendNotificationScreen() {
    var type by remember { mutableStateOf(CustomerNotificationType.PUSH) }
    var title by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var resultMessage by remember { mutableStateOf<String?>(null) }
    var resultIsError by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun send() {
        val trimmedTitle = title.trim()
        if (trimmedTitle.isEmpty()) {
            resultMessage = "Enter a title before sending."
            resultIsError = true
            return
        }
        sending = true
        resultMessage = null
        scope.launch {
            try {
                val response = ApiClient.service.sendCustomerNotification(
                    SendCustomerNotificationRequest(
                        type = type.apiValue,
                        title = trimmedTitle,
                        body = body.trim().ifEmpty { null },
                        targetType = "all",
                    )
                )
                val sent = response.body()
                if (response.isSuccessful && sent != null) {
                    resultMessage = "Sent to ${sent.customerCount} customer${if (sent.customerCount == 1) "" else "s"}."
                    resultIsError = false
                    title = ""
                    body = ""
                } else {
                    resultMessage = "Couldn't send notification (${response.code()}). Please try again."
                    resultIsError = true
                }
            } catch (_: Exception) {
                resultMessage = "Couldn't send notification. Check your connection and try again."
                resultIsError = true
            }
            sending = false
        }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Notifications") }) }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
        ) {
            Card(shape = RoundedCornerShape(16.dp)) {
                Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Campaign, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(12.dp))
                    Text(
                        "Send an announcement to every customer — a new update, cheaper packages, a promotion, or an important notice.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }

            Spacer(Modifier.height(20.dp))

            Text("Type", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CustomerNotificationType.entries.forEach { option ->
                    FilterChip(selected = type == option, onClick = { type = option }, label = { Text(option.label) })
                }
            }

            Spacer(Modifier.height(20.dp))

            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                label = { Text("Title") },
                placeholder = { Text("e.g. New cheaper data packages available") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(12.dp))

            OutlinedTextField(
                value = body,
                onValueChange = { body = it },
                label = { Text("Message (optional)") },
                placeholder = { Text("Add more detail for customers here…") },
                minLines = 3,
                maxLines = 6,
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(20.dp))

            Button(
                onClick = { send() },
                enabled = !sending && title.trim().isNotEmpty(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (sending) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    Spacer(Modifier.width(8.dp))
                }
                Text(if (sending) "Sending…" else "Send to All Customers")
            }

            resultMessage?.let { message ->
                Spacer(Modifier.height(12.dp))
                Text(
                    message,
                    color = if (resultIsError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}
