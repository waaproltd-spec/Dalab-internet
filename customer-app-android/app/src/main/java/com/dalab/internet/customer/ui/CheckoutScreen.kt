package com.dalab.internet.customer.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.R
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.data.companyLogoRes
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.CreateOrderRequest
import com.dalab.internet.customer.prefs.LocalizationManager
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
    "EVC Plus" to WalletOption("EVC Plus", "Hormuud", Color(0xFF16A34A), R.drawable.logo_hormuud),
    "eDahab" to WalletOption("eDahab", "Somtel", Color(0xFFF2C200), R.drawable.logo_somtel),
    "JEEB" to WalletOption("JEEB", "Somnet", Color(0xFF1D4ED8), R.drawable.logo_somnet),
)

/**
 * USSD dial prefix per wallet — fixed regardless of which company's
 * package was purchased, combined with that company's own admin number
 * (company.paymentNumber) and the amount: "*{prefix}*{number}*{amount}#".
 * Replaces the old company.paymentUssdTemplate-based dial string, which
 * was wrong whenever the customer picked a wallet other than the
 * purchased company's own gateway (e.g. paying via JEEB for a Somtel
 * package used to wrongly dial Somtel's own eDahab code).
 */
private val WALLET_DIAL_PREFIX = mapOf(
    "EVC Plus" to "712",
    "eDahab" to "110",
    "JEEB" to "812",
)

/**
 * A minimal, single-screen payment page: the number to pay as plain text
 * plus the selected package's details (name, provider, price, validity),
 * the amount, the sender/receiver phone fields (required, validated on
 * submit), a single-select payment wallet, and one Pay Now button that
 * creates the order and opens the dialer with the USSD code pre-filled
 * for whichever wallet was selected.
 */
@Composable
fun CheckoutScreen(company: Company, pkg: PackageItem, onBack: () -> Unit, onOrderCreated: (CustomerOrder) -> Unit) {
    val context = LocalContext.current
    var senderPhone by remember { mutableStateOf(SessionManager.currentCustomer()?.phone ?: "") }
    var receiverPhone by remember { mutableStateOf(SessionManager.currentCustomer()?.phone ?: "") }
    var attemptedSubmit by remember { mutableStateOf(false) }
    var selectedPaymentMethod by remember { mutableStateOf<String?>(null) }
    val payNumber = company.paymentNumber?.takeIf { it.isNotBlank() }
    val logoRes = remember(company.id) { companyLogoRes(company.id) }

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

    val compact = LocalConfiguration.current.screenHeightDp < 700
    val outerPadding = if (compact) 14.dp else 20.dp
    val gap = if (compact) 12.dp else 18.dp
    val buttonHeight = if (compact) 48.dp else 56.dp

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(ScreenBg)
            .padding(horizontal = outerPadding, vertical = outerPadding.times(0.6f)),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
            }
            Text("Payment", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        }

        Spacer(Modifier.height(gap * 0.5f))
        Text("Send payment to this number.", color = MutedText, fontSize = 13.sp)

        Spacer(Modifier.height(gap))
        Surface(
            color = PanelBg,
            shape = RoundedCornerShape(20.dp),
            border = BorderStroke(1.dp, PanelBorder),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 18.dp, vertical = if (compact) 14.dp else 18.dp),
            ) {
                Text(
                    payNumber ?: "Not available",
                    color = Color.White,
                    fontWeight = FontWeight.Black,
                    fontSize = if (compact) 24.sp else 28.sp,
                )
                Spacer(Modifier.height(if (compact) 10.dp else 14.dp))
                Divider(color = PanelBorder, thickness = 1.dp)
                Spacer(Modifier.height(if (compact) 10.dp else 14.dp))
                Text(pkg.name, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Spacer(Modifier.height(4.dp))
                Text(
                    buildList {
                        add(company.name)
                        add("$${"%.2f".format(pkg.price)}")
                        pkg.validity?.takeIf { it.isNotBlank() }?.let { add(it) }
                    }.joinToString("  •  "),
                    color = MutedText,
                    fontSize = 12.sp,
                )
            }
        }

        Spacer(Modifier.height(gap))
        Text("Amount to Pay", color = MutedText, fontSize = 13.sp)
        Spacer(Modifier.height(4.dp))
        Text(
            "$${"%.2f".format(pkg.price)}",
            color = DalabGreen,
            fontWeight = FontWeight.Black,
            fontSize = if (compact) 26.sp else 30.sp,
        )

        Spacer(Modifier.height(gap))
        PhoneInputField(
            label = LocalizationManager.tr("Number sending payment", "Lambarka Lacagta Ka Diraysid"),
            value = senderPhone,
            onValueChange = { senderPhone = it },
            logoRes = logoRes,
            showError = attemptedSubmit && senderPhone.isBlank(),
            compact = compact,
        )
        Spacer(Modifier.height(if (compact) 8.dp else 12.dp))
        PhoneInputField(
            label = LocalizationManager.tr("Receiver number", "Lambarka Lacagta u Rabtid"),
            value = receiverPhone,
            onValueChange = { receiverPhone = it },
            logoRes = logoRes,
            showError = attemptedSubmit && receiverPhone.isBlank(),
            compact = compact,
        )

        Spacer(Modifier.height(gap))
        Text("Choose Your Payment Method", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
        Spacer(Modifier.height(if (compact) 8.dp else 12.dp))

        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            WALLET_OPTIONS.forEach { (methodKey, wallet) ->
                val active = methodKey.equals(selectedPaymentMethod, ignoreCase = true)
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(16.dp))
                        .border(
                            width = if (active) 2.dp else 1.dp,
                            color = if (active) DalabGreen else PanelBorder,
                            shape = RoundedCornerShape(16.dp),
                        )
                        .background(PanelBg)
                        .clickable { selectedPaymentMethod = methodKey }
                        .padding(vertical = if (compact) 10.dp else 14.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(
                        modifier = Modifier
                            .size(if (compact) 44.dp else 52.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(wallet.color),
                        contentAlignment = Alignment.Center,
                    ) {
                        Image(
                            painter = painterResource(wallet.logoRes),
                            contentDescription = methodKey,
                            modifier = Modifier.size(if (compact) 26.dp else 30.dp),
                        )
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(wallet.label, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 12.sp, maxLines = 1)
                    Text(wallet.providerLabel, color = MutedText, fontSize = 10.sp, maxLines = 1)
                }
            }
        }

        if (error != null) {
            Spacer(Modifier.height(8.dp))
            Text(error!!, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
        }
        if (queued) {
            Spacer(Modifier.height(8.dp))
            Text(
                "You're offline — this order will be placed automatically once you're back online.",
                color = DalabGreen,
                fontSize = 12.sp,
            )
        }

        Spacer(Modifier.weight(1f))

        val payEnabled = selectedPaymentMethod != null && !submitting && !queued
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
                    attemptedSubmit = true
                    if (senderPhone.isBlank() || receiverPhone.isBlank()) {
                        return@clickable
                    }
                    error = null
                    submitting = true
                    val request = CreateOrderRequest(
                        companyId = company.id,
                        packageId = pkg.id,
                        senderPhone = senderPhone.trim(),
                        receiverPhone = receiverPhone.trim(),
                        paymentMethod = selectedPaymentMethod,
                        clientRequestId = clientRequestId,
                    )
                    scope.launch {
                        try {
                            val response = RetryClassifier.requireSuccessful(ApiClient.service.createOrder(request))
                            val order = response.body()
                            if (order != null) {
                                val prefix = WALLET_DIAL_PREFIX[selectedPaymentMethod]
                                val dialTarget = if (prefix != null && payNumber != null) {
                                    "*$prefix*$payNumber*${"%.2f".format(pkg.price)}#"
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
                    if (submitting) "Processing..." else if (queued) "Queued" else "Pay Now",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 17.sp,
                )
            }
        }
    }
}

@Composable
private fun PhoneInputField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    logoRes: Int?,
    showError: Boolean,
    compact: Boolean,
) {
    Column {
        Text(label, color = MutedText, fontSize = 12.sp)
        Spacer(Modifier.height(4.dp))
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = { Text("6XXXXXXX", color = MutedText) },
            singleLine = true,
            isError = showError,
            leadingIcon = if (logoRes != null) {
                {
                    Image(
                        painter = painterResource(logoRes),
                        contentDescription = null,
                        modifier = Modifier.size(26.dp).clip(CircleShape),
                    )
                }
            } else null,
            supportingText = if (showError) {
                { Text("Please enter your number", color = MaterialTheme.colorScheme.error, fontSize = 11.sp) }
            } else null,
            shape = RoundedCornerShape(14.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = DalabGreen,
                unfocusedBorderColor = PanelBorder,
                focusedTextColor = Color.White,
                unfocusedTextColor = Color.White,
                cursorColor = DalabGreen,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(if (compact) 54.dp else 58.dp),
        )
    }
}
