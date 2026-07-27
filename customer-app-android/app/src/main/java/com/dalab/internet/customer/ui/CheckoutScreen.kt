package com.dalab.internet.customer.ui

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.PackageItem

private val DalabIndigo = Color(0xFF1D2E8C)
private val DalabGreen = Color(0xFF16A34A)

data class PaymentDraft(
    val company: Company,
    val pkg: PackageItem,
    val senderPhone: String,
    val receiverPhone: String,
    val paymentMethod: String,
)

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
 *
 * This screen only reviews the order and picks a payment method — tapping
 * "Pay Now" hands off to PaymentInstructionsScreen, which shows the actual
 * phone number/amount to send to and only creates the order once the
 * customer confirms they've sent the payment ("I've Paid").
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CheckoutScreen(company: Company, pkg: PackageItem, onBack: () -> Unit, onProceedToPayment: (PaymentDraft) -> Unit) {
    var senderPhone by remember { mutableStateOf(SessionManager.currentCustomer()?.phone ?: "") }
    var receiverPhone by remember { mutableStateOf(SessionManager.currentCustomer()?.phone ?: "") }
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
                title = { Text("Confirm Order", color = Color.White, fontWeight = FontWeight.Bold) },
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

            val payEnabled = senderPhone.isNotBlank() && receiverPhone.isNotBlank()
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp)
                    .clip(RoundedCornerShape(28.dp))
                    .background(
                        if (payEnabled) Brush.horizontalGradient(listOf(DalabIndigo, DalabGreen))
                        else Brush.horizontalGradient(listOf(Color(0xFFBDC2E0), Color(0xFFBDC2E0)))
                    )
                    .clickable(enabled = payEnabled) {
                        onProceedToPayment(
                            PaymentDraft(
                                company = company,
                                pkg = pkg,
                                senderPhone = senderPhone.trim(),
                                receiverPhone = receiverPhone.trim(),
                                paymentMethod = selectedPaymentMethod,
                            )
                        )
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text("Pay Now", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp)
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
