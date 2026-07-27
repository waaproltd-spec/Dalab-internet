package com.dalab.internet.customer.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.CreateOrderRequest
import com.dalab.internet.customer.queue.OrderCreateAction
import com.dalab.internet.customer.queue.PendingActionQueue
import com.dalab.internet.customer.queue.RetryClassifier
import kotlinx.coroutines.launch
import java.util.UUID

private val DalabIndigo = Color(0xFF1D2E8C)
private val DalabGreen = Color(0xFF16A34A)

private data class PaymentMethodOption(val label: String, val color: Color)
private val KNOWN_PAYMENT_METHODS = listOf(
    PaymentMethodOption("EVC Plus", Color(0xFF16A34A)),
    PaymentMethodOption("eDahab", Color(0xFFD9A400)),
    PaymentMethodOption("JEEB", Color(0xFF1D2E8C)),
)

/**
 * Payment method choice mirrors the real per-provider gateway (EVC Plus /
 * JEEB / eDahab / Manual — see `company.gateway`, seeded in
 * admin-backend-ts/src/db/seed.ts), plus JEEB as a universal alternative
 * since it works as a cross-carrier payment app regardless of which
 * provider's package is being bought (e.g. a Hormuud package can be paid via
 * Hormuud's own EVC Plus, or via JEEB). A "Manual" gateway (Amtel — no SMS
 * payment confirmation, verified through a separate flow) has no selectable
 * alternative. Only the applicable icon(s) are selectable/lit; the rest stay
 * dimmed and non-interactive.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CheckoutScreen(company: Company, pkg: PackageItem, onBack: () -> Unit, onOrderCreated: (CustomerOrder) -> Unit) {
    // Both default to the same number the customer already logged in with —
    // pre-filled so they never have to type it, but each stays independently
    // editable: the sender is whichever number actually pays, the receiver
    // is whichever number the data gets delivered to (usually the same
    // number, but not always — e.g. buying data as a gift for someone else).
    var senderPhone by remember { mutableStateOf(SessionManager.currentCustomer()?.phone ?: "") }
    var receiverPhone by remember { mutableStateOf(SessionManager.currentCustomer()?.phone ?: "") }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var queued by remember { mutableStateOf(false) }
    // Reused across manual retaps of the same in-flight attempt (e.g. after a
    // network error) so a retry — including from the offline queue — can't
    // create a second order server-side.
    val clientRequestId = remember { UUID.randomUUID().toString() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val selectableMethods = remember(company.gateway) {
        if (company.gateway.isNullOrBlank() || company.gateway.equals("Manual", ignoreCase = true)) {
            listOf(company.gateway ?: "Manual")
        } else {
            listOf(company.gateway, "JEEB").distinctBy { it.lowercase() }
        }
    }
    var selectedPaymentMethod by remember(company.gateway) { mutableStateOf(selectableMethods.first()) }
    val brandColor = remember(company.colorHex) {
        try {
            Color(android.graphics.Color.parseColor(company.colorHex))
        } catch (_: Exception) {
            DalabIndigo
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Confirm Payment", color = Color.White, fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = brandColor),
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(20.dp)
                .fillMaxSize(),
        ) {
            OutlinedTextField(
                value = senderPhone,
                onValueChange = { senderPhone = it },
                label = { Text("Number sending payment") },
                singleLine = true,
                shape = RoundedCornerShape(28.dp),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = brandColor),
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(14.dp))
            OutlinedTextField(
                value = receiverPhone,
                onValueChange = { receiverPhone = it },
                label = { Text("Receiver number (target)") },
                singleLine = true,
                shape = RoundedCornerShape(28.dp),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = brandColor),
                modifier = Modifier.fillMaxWidth(),
            )

            company.paymentNumber?.takeIf { it.isNotBlank() }?.let { payNumber ->
                Spacer(Modifier.height(16.dp))
                Surface(
                    color = brandColor.copy(alpha = 0.08f),
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(modifier = Modifier.padding(14.dp)) {
                        Text("Send payment to", fontSize = 12.sp, color = Color(0xFF6B7094))
                        Spacer(Modifier.height(2.dp))
                        Text(payNumber, fontWeight = FontWeight.Bold, fontSize = 18.sp, color = brandColor)
                        Spacer(Modifier.height(2.dp))
                        Text("Amount: $${"%.2f".format(pkg.price)}", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    }
                }
            }

            Spacer(Modifier.height(24.dp))
            Text("Select Payment Method", fontWeight = FontWeight.Bold, fontSize = 15.sp)
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                KNOWN_PAYMENT_METHODS.forEach { method ->
                    val selectable = selectableMethods.any { it.equals(method.label, ignoreCase = true) }
                    val active = method.label.equals(selectedPaymentMethod, ignoreCase = true)
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.clickable(enabled = selectable) { selectedPaymentMethod = method.label },
                    ) {
                        Box(
                            modifier = Modifier
                                .size(64.dp)
                                .clip(CircleShape)
                                .background(if (active) method.color else method.color.copy(alpha = 0.25f)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                method.label.take(2).uppercase(),
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = 16.sp,
                            )
                        }
                        Spacer(Modifier.height(6.dp))
                        Text(
                            method.label,
                            fontSize = 12.sp,
                            fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                            color = if (active) method.color else Color.Gray,
                        )
                    }
                }
            }

            Spacer(Modifier.height(24.dp))
            Surface(
                color = Color(0xFFEFF7F0),
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.padding(20.dp)) {
                    Text("Service Details", fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    Spacer(Modifier.height(14.dp))
                    ServiceDetailRow("Provider", company.name)
                    ServiceDetailRow("Package", pkg.name)
                    ServiceDetailRow("Amount", "$${"%.2f".format(pkg.price)}")
                    val extras = buildList {
                        if (pkg.mb > 0) add(Icons.Filled.Wifi to "${pkg.mb} MB")
                        if (pkg.minutes > 0) add(Icons.Filled.Call to "${pkg.minutes} minutes")
                        if (pkg.sms > 0) add(Icons.Filled.Sms to "${pkg.sms} SMS")
                        pkg.validity?.takeIf { it.isNotBlank() }?.let { add(Icons.Filled.Schedule to it) }
                    }
                    if (extras.isNotEmpty()) {
                        Spacer(Modifier.height(6.dp))
                        extras.forEach { (icon, label) ->
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
                                Icon(icon, contentDescription = null, tint = DalabGreen, modifier = Modifier.size(15.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(label, fontSize = 13.sp, color = Color(0xFF44494F))
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(20.dp))
            if (error != null) {
                Text(error!!, color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(12.dp))
            }
            if (queued) {
                Text(
                    "You're offline — this order will be placed automatically once you're back online.",
                    color = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.height(12.dp))
            }

            val payEnabled = senderPhone.isNotBlank() && receiverPhone.isNotBlank() && !submitting && !queued
            val onPay: () -> Unit = {
                error = null
                submitting = true
                val request = CreateOrderRequest(
                    companyId = company.id,
                    packageId = pkg.id,
                    senderPhone = senderPhone.trim().ifBlank { null },
                    receiverPhone = receiverPhone.trim().ifBlank { null },
                    paymentMethod = selectedPaymentMethod,
                    clientRequestId = clientRequestId,
                )
                scope.launch {
                    try {
                        val response = RetryClassifier.requireSuccessful(ApiClient.service.createOrder(request))
                        val order = response.body()
                        if (order != null) {
                            company.paymentUssdTemplate?.takeIf { it.isNotBlank() }?.let { template ->
                                val ussd = template.replace("{amount}", "%.2f".format(pkg.price))
                                context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(ussd))))
                            }
                            onOrderCreated(order)
                        } else {
                            error = "Couldn't place this order. Please try again."
                        }
                    } catch (e: Exception) {
                        if (RetryClassifier.isRetryable(e)) {
                            PendingActionQueue.enqueue(
                                id = UUID.randomUUID().toString(),
                                type = PendingActionQueue.Type.ORDER_CREATE,
                                payload = OrderCreateAction(request),
                            )
                            queued = true
                        } else {
                            error = "Couldn't place this order. Please try again."
                        }
                    }
                    submitting = false
                }
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp)
                    .clip(RoundedCornerShape(28.dp))
                    .background(
                        if (payEnabled) Brush.horizontalGradient(listOf(DalabIndigo, DalabGreen))
                        else Brush.horizontalGradient(listOf(Color(0xFFBDC2E0), Color(0xFFBDC2E0)))
                    )
                    .clickable(enabled = payEnabled, onClick = onPay),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (submitting) "Processing..." else if (queued) "Queued" else "Pay Now",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                )
            }
        }
    }
}

@Composable
private fun ServiceDetailRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, fontSize = 13.sp, color = Color(0xFF6B7094))
        Text(value, fontWeight = FontWeight.Bold, fontSize = 13.sp)
    }
}
