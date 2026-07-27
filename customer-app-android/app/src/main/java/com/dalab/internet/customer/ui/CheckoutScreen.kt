package com.dalab.internet.customer.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Lock
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.R
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

private val DalabGreen = Color(0xFF16A34A)
private val ScreenBg = Color(0xFF0B0F1E)
private val PanelBg = Color(0xFF141A2E)
private val PanelBorder = Color(0xFF232B45)
private val MutedText = Color(0xFF9CA3B8)

private data class WalletOption(val label: String, val providerLabel: String, val color: Color, val logoRes: Int)

private val WALLET_OPTIONS = mapOf(
    "EVC Plus" to WalletOption("Evc Plus", "HORMUUD TELECOM", Color(0xFF16A34A), R.drawable.logo_hormuud),
    "eDahab" to WalletOption("eDahab", "SOMTEL TELECOM", Color(0xFFF2C200), R.drawable.logo_somtel),
    "JEEB" to WalletOption("Jeeb", "SOMNET TELECOM", Color(0xFF1D4ED8), R.drawable.logo_somnet),
)

/**
 * Single-screen checkout: review the order, pick a payment wallet, see the
 * locked admin number to send payment to, and tap "Pay Now" to both place
 * the order (pending, awaiting payment verification) and open the dialer
 * with the USSD code pre-filled — matching the "Select Payment Wallet"
 * reference design (dark cards per wallet + locked admin number + single
 * dial button) rather than a separate confirmation step.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CheckoutScreen(company: Company, pkg: PackageItem, onBack: () -> Unit, onOrderCreated: (CustomerOrder) -> Unit) {
    val context = LocalContext.current
    var senderPhone by remember { mutableStateOf(SessionManager.currentCustomer()?.phone ?: "") }
    var receiverPhone by remember { mutableStateOf(SessionManager.currentCustomer()?.phone ?: "") }
    var selectedPaymentMethod by remember { mutableStateOf<String?>(null) }
    val payNumber = company.paymentNumber?.takeIf { it.isNotBlank() }

    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var queued by remember { mutableStateOf(false) }
    var createdOrder by remember { mutableStateOf<CustomerOrder?>(null) }
    val clientRequestId = remember { UUID.randomUUID().toString() }
    val scope = rememberCoroutineScope()

    val successOrder = createdOrder
    if (successOrder != null) {
        PaymentSuccessScreen(order = successOrder, onContinue = { onOrderCreated(successOrder) })
        return
    }

    // Scales spacing/font sizes down a notch on shorter screens so the whole
    // form has a real chance of fitting without scrolling on small phones;
    // verticalScroll below is the actual guarantee that nothing is ever cut
    // off, even on the smallest/most cramped devices.
    val compact = LocalConfiguration.current.screenHeightDp < 700
    val outerPadding = if (compact) 14.dp else 20.dp
    val fieldGap = if (compact) 10.dp else 12.dp
    val sectionGap = if (compact) 14.dp else 20.dp
    val walletSectionGap = if (compact) 16.dp else 24.dp
    val walletCardGap = if (compact) 8.dp else 12.dp
    val walletCardPadding = if (compact) 10.dp else 14.dp
    val buttonHeight = if (compact) 48.dp else 54.dp
    val sectionTitleSize = if (compact) 15.sp else 16.sp
    val cardTitleSize = if (compact) 13.sp else 14.sp

    Scaffold(
        containerColor = ScreenBg,
        topBar = {
            TopAppBar(
                title = { Text("Confirm Order", color = Color.White, fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = ScreenBg),
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(outerPadding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
        ) {
            OutlinedTextField(
                value = senderPhone,
                onValueChange = { senderPhone = it },
                label = { Text("Number sending payment", color = MutedText) },
                singleLine = true,
                shape = RoundedCornerShape(14.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = DalabGreen,
                    unfocusedBorderColor = PanelBorder,
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White,
                    cursorColor = DalabGreen,
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(fieldGap))
            OutlinedTextField(
                value = receiverPhone,
                onValueChange = { receiverPhone = it },
                label = { Text("Receiver number (target)", color = MutedText) },
                singleLine = true,
                shape = RoundedCornerShape(14.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = DalabGreen,
                    unfocusedBorderColor = PanelBorder,
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White,
                    cursorColor = DalabGreen,
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(sectionGap))
            Surface(color = PanelBg, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(if (compact) 12.dp else 16.dp)) {
                    Text("Service Details", fontWeight = FontWeight.Bold, fontSize = cardTitleSize, color = Color.White)
                    Spacer(Modifier.height(if (compact) 6.dp else 10.dp))
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
                        Spacer(Modifier.height(4.dp))
                        extras.forEach { (icon, label) ->
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
                                Icon(icon, contentDescription = null, tint = DalabGreen, modifier = Modifier.size(14.dp))
                                Spacer(Modifier.width(8.dp))
                                Text(label, fontSize = 12.sp, color = MutedText)
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(walletSectionGap))
            Text("Select Your Payment Method", fontWeight = FontWeight.Bold, fontSize = sectionTitleSize, color = Color.White)
            Spacer(Modifier.height(6.dp))
            Text(
                "Please select the mobile money account you will use to send the payment.",
                fontSize = 12.sp,
                color = MutedText,
            )
            Spacer(Modifier.height(if (compact) 8.dp else 12.dp))

            WALLET_OPTIONS.forEach { (methodKey, wallet) ->
                val active = methodKey.equals(selectedPaymentMethod, ignoreCase = true)
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = walletCardGap)
                        .clip(RoundedCornerShape(16.dp))
                        .border(
                            width = if (active) 2.dp else 1.dp,
                            color = if (active) DalabGreen else PanelBorder,
                            shape = RoundedCornerShape(16.dp),
                        )
                        .background(PanelBg)
                        .clickable { selectedPaymentMethod = methodKey }
                        .padding(walletCardPadding),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(width = if (compact) 76.dp else 88.dp, height = if (compact) 48.dp else 56.dp)
                                .clip(RoundedCornerShape(10.dp))
                                .background(wallet.color),
                            contentAlignment = Alignment.Center,
                        ) {
                            Image(
                                painter = painterResource(wallet.logoRes),
                                contentDescription = methodKey,
                                modifier = Modifier.size(if (compact) 34.dp else 40.dp),
                            )
                        }
                        Spacer(Modifier.width(if (compact) 12.dp else 16.dp))
                        Column {
                            Text(wallet.label, color = Color.White, fontWeight = FontWeight.Bold, fontSize = if (compact) 14.sp else 16.sp)
                            Text(wallet.providerLabel, color = MutedText, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }

            Spacer(Modifier.height(8.dp))
            Surface(
                color = PanelBg,
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, PanelBorder),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.padding(if (compact) 12.dp else 16.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.Lock, contentDescription = null, tint = Color(0xFFF2A900), modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("Admin Number:", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = cardTitleSize)
                        }
                        Surface(shape = RoundedCornerShape(10.dp), border = BorderStroke(1.dp, PanelBorder), color = Color.Transparent) {
                            Text(
                                payNumber ?: "Not available",
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = if (compact) 14.sp else 15.sp,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                            )
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(
                        if (selectedPaymentMethod != null) {
                            "Automatically selected for $selectedPaymentMethod. You cannot edit this number."
                        } else {
                            "Select a payment method above. You cannot edit this number."
                        },
                        color = MutedText,
                        fontSize = 12.sp,
                    )
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
                    color = DalabGreen,
                )
                Spacer(Modifier.height(12.dp))
            }

            Spacer(Modifier.height(sectionGap))

            val payEnabled = senderPhone.isNotBlank() && receiverPhone.isNotBlank() && selectedPaymentMethod != null && !submitting && !queued
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(buttonHeight)
                    .clip(RoundedCornerShape(28.dp))
                    .background(
                        if (payEnabled) Brush.horizontalGradient(listOf(DalabGreen, Color(0xFF0F9E76)))
                        else Brush.horizontalGradient(listOf(Color(0xFF3A4257), Color(0xFF3A4257)))
                    )
                    .clickable(enabled = payEnabled) {
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
                                    val template = company.paymentUssdTemplate?.takeIf { it.isNotBlank() }
                                    val dialTarget = if (template != null) {
                                        template.replace("{amount}", "%.2f".format(pkg.price))
                                    } else {
                                        payNumber
                                    }
                                    if (dialTarget != null) {
                                        context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(dialTarget))))
                                    }
                                    createdOrder = order
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
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Call, contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(
                        if (submitting) "Processing..." else if (queued) "Queued" else "PAY NOW ($${"%.2f".format(pkg.price)})",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp,
                    )
                }
            }

            Spacer(Modifier.height(10.dp))
            Text(
                "Tapping PAY NOW will open your mobile dialer to complete the payment transaction safely.",
                fontSize = 12.sp,
                color = MutedText,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(outerPadding))
        }
    }
}

@Composable
private fun ServiceDetailRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, fontSize = 13.sp, color = MutedText)
        Text(value, fontWeight = FontWeight.Bold, fontSize = 13.sp, color = Color.White)
    }
}
