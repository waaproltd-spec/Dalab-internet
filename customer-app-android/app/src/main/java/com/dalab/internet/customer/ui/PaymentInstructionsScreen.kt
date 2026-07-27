package com.dalab.internet.customer.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.CreateOrderRequest
import com.dalab.internet.customer.queue.OrderCreateAction
import com.dalab.internet.customer.queue.PendingActionQueue
import com.dalab.internet.customer.queue.RetryClassifier
import kotlinx.coroutines.launch
import java.util.UUID

private val DalabIndigo = Color(0xFF1D2E8C)
private val DalabGreen = Color(0xFF16A34A)

/**
 * Shown after "Pay Now" on Checkout instead of dialing immediately — the
 * customer reviews the exact number/amount to send, can copy the number or
 * open the dialer themselves, and only once they confirm with "I've Paid" is
 * the order actually created (POST /orders) and handed off to
 * OrderDetailScreen for payment verification.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PaymentInstructionsScreen(draft: PaymentDraft, onBack: () -> Unit, onOrderCreated: (CustomerOrder) -> Unit) {
    val context = LocalContext.current
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var queued by remember { mutableStateOf(false) }
    val clientRequestId = remember { UUID.randomUUID().toString() }
    val scope = rememberCoroutineScope()
    val brandColor = remember(draft.company.colorHex) {
        try {
            Color(android.graphics.Color.parseColor(draft.company.colorHex))
        } catch (_: Exception) {
            DalabIndigo
        }
    }
    val payNumber = draft.company.paymentNumber?.takeIf { it.isNotBlank() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Send Payment", color = Color.White, fontWeight = FontWeight.Bold) },
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
                .padding(24.dp)
                .fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(12.dp))
            Text("Phone Number", fontSize = 13.sp, color = Color(0xFF6B7094), fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            Text(
                payNumber ?: "Not available",
                fontSize = 34.sp,
                fontWeight = FontWeight.Black,
                color = brandColor,
            )

            Spacer(Modifier.height(24.dp))
            Surface(color = Color(0xFFF6F7FC), shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(18.dp)) {
                    PaymentDetailRow("Payment Method", draft.paymentMethod)
                    Spacer(Modifier.height(8.dp))
                    PaymentDetailRow("Amount", "$${"%.2f".format(draft.pkg.price)}")
                }
            }

            Spacer(Modifier.height(20.dp))
            Text(
                "Send the payment to the phone number above.",
                fontSize = 14.sp,
                color = Color(0xFF44494F),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )

            Spacer(Modifier.height(28.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                OutlinedButton(
                    onClick = {
                        if (payNumber != null) {
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.setPrimaryClip(ClipData.newPlainText("Payment number", payNumber))
                        }
                    },
                    enabled = payNumber != null,
                    modifier = Modifier.weight(1f).height(50.dp),
                ) {
                    Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Copy Number")
                }
                OutlinedButton(
                    onClick = {
                        val template = draft.company.paymentUssdTemplate?.takeIf { it.isNotBlank() }
                        val dialTarget = if (template != null) {
                            template.replace("{amount}", "%.2f".format(draft.pkg.price))
                        } else {
                            payNumber
                        }
                        if (dialTarget != null) {
                            context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(dialTarget))))
                        }
                    },
                    enabled = payNumber != null,
                    modifier = Modifier.weight(1f).height(50.dp),
                ) {
                    Icon(Icons.Filled.Call, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Call")
                }
            }

            Spacer(Modifier.height(16.dp))
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

            Spacer(Modifier.weight(1f))

            val confirmEnabled = !submitting && !queued
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp)
                    .clip(RoundedCornerShape(28.dp))
                    .background(
                        if (confirmEnabled) Brush.horizontalGradient(listOf(DalabIndigo, DalabGreen))
                        else Brush.horizontalGradient(listOf(Color(0xFFBDC2E0), Color(0xFFBDC2E0)))
                    )
                    .clickable(enabled = confirmEnabled) {
                        error = null
                        submitting = true
                        val request = CreateOrderRequest(
                            companyId = draft.company.id,
                            packageId = draft.pkg.id,
                            senderPhone = draft.senderPhone.ifBlank { null },
                            receiverPhone = draft.receiverPhone.ifBlank { null },
                            paymentMethod = draft.paymentMethod,
                            clientRequestId = clientRequestId,
                        )
                        scope.launch {
                            try {
                                val response = RetryClassifier.requireSuccessful(ApiClient.service.createOrder(request))
                                val order = response.body()
                                if (order != null) {
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
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (submitting) "Processing..." else if (queued) "Queued" else "I've Paid",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                )
            }
        }
    }
}

@Composable
private fun PaymentDetailRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, fontSize = 13.sp, color = Color(0xFF6B7094))
        Text(value, fontWeight = FontWeight.Bold, fontSize = 14.sp)
    }
}
