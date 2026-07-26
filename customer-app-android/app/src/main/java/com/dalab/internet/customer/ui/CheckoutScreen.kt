package com.dalab.internet.customer.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.CreateOrderRequest
import kotlinx.coroutines.launch

/**
 * Payment method choice mirrors the real per-provider gateway (EVC Plus /
 * JEEB / eDahab / Manual — see `company.gateway`, seeded in
 * admin-backend-ts/src/db/seed.ts) rather than a generic list, since each
 * provider only actually supports its own mobile-money gateway.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CheckoutScreen(company: Company, pkg: PackageItem, onBack: () -> Unit, onOrderCreated: (CustomerOrder) -> Unit) {
    var receiverPhone by remember { mutableStateOf(SessionManager.currentCustomer()?.phone ?: "") }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val paymentMethod = company.gateway ?: "Manual"

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Confirm Payment") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).padding(20.dp).fillMaxSize()) {
            Text("Service Details", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            DetailRow("Provider", company.name)
            DetailRow("Package", pkg.name)
            DetailRow("Amount", "$${"%.2f".format(pkg.price)}")

            Spacer(Modifier.height(20.dp))
            Text("Payment Method", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            AssistChip(onClick = {}, label = { Text(paymentMethod) })

            Spacer(Modifier.height(20.dp))
            OutlinedTextField(
                value = receiverPhone,
                onValueChange = { receiverPhone = it },
                label = { Text("Receiver number (target)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(20.dp))
            if (error != null) {
                Text(error!!, color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(12.dp))
            }

            Button(
                onClick = {
                    error = null
                    submitting = true
                    scope.launch {
                        try {
                            val response = ApiClient.service.createOrder(
                                CreateOrderRequest(
                                    companyId = company.id,
                                    packageId = pkg.id,
                                    receiverPhone = receiverPhone.trim().ifBlank { null },
                                    paymentMethod = paymentMethod,
                                )
                            )
                            val order = response.body()
                            if (response.isSuccessful && order != null) onOrderCreated(order)
                            else error = "Couldn't place this order. Please try again."
                        } catch (_: Exception) {
                            error = "Network error while placing your order."
                        }
                        submitting = false
                    }
                },
                enabled = receiverPhone.isNotBlank() && !submitting,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (submitting) "Processing..." else "Pay Now")
            }
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(value, fontWeight = FontWeight.Medium)
    }
}
