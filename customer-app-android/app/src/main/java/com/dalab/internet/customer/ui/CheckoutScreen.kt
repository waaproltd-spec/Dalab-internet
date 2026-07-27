package com.dalab.internet.customer.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
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
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.data.PaymentWallet
import com.dalab.internet.customer.data.companyLogoRes
import com.dalab.internet.customer.data.walletLogoRes
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

/**
 * Payment wallets (EVC Plus/eDahab/JEEB/Amtel Pay/...) are fetched from
 * GET /payment-wallets — Super-Admin managed, never hardcoded, so enabling/
 * disabling one there takes effect immediately here. Only the dial prefix +
 * display info come from the wallet; the actual number dialed is always the
 * purchased company's own payment_number (company.paymentNumber below),
 * combined as "*{prefix}*{companyPaymentNumber}*{amount}#" — this is
 * unchanged from before, still per-company, not per-wallet.
 */

/**
 * A minimal, single-screen payment page: the number to pay as plain text
 * plus the selected package's details (name, provider, price, validity),
 * the amount, the sender/receiver phone fields (required, validated on
 * submit), a single-select payment wallet, and one Pay Now button that
 * creates the order and opens the dialer with the USSD code pre-filled
 * for whichever wallet was selected.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CheckoutScreen(company: Company, pkg: PackageItem, onBack: () -> Unit, onOrderCreated: (CustomerOrder) -> Unit) {
    val context = LocalContext.current
    var senderPhone by remember { mutableStateOf(SessionManager.currentCustomer()?.phone ?: "") }
    var receiverPhone by remember { mutableStateOf(SessionManager.currentCustomer()?.phone ?: "") }
    var attemptedSubmit by remember { mutableStateOf(false) }
    var selectedWallet by remember { mutableStateOf<PaymentWallet?>(null) }
    var showPaymentSheet by remember { mutableStateOf(false) }
    var wallets by remember { mutableStateOf<List<PaymentWallet>>(emptyList()) }
    var walletsError by remember { mutableStateOf<String?>(null) }
    val payNumber = company.paymentNumber?.takeIf { it.isNotBlank() }
    val logoRes = remember(company.id) { companyLogoRes(company.id) }

    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var queued by remember { mutableStateOf(false) }
    var createdOrder by remember { mutableStateOf<CustomerOrder?>(null) }
    val clientRequestId = remember { UUID.randomUUID().toString() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        try {
            val response = ApiClient.service.getPaymentWallets()
            val enabled = response.body().orEmpty().filter { it.enabled }
            wallets = enabled
            if (enabled.size == 1) selectedWallet = enabled.first()
        } catch (e: Exception) {
            walletsError = "Couldn't load payment methods. Please try again."
        }
    }

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
            Text("Confirm Order", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
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
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        buildList {
                            add(company.name)
                            pkg.validity?.takeIf { it.isNotBlank() }?.let { add(it) }
                        }.joinToString("  •  "),
                        color = MutedText,
                        fontSize = 12.sp,
                    )
                    Spacer(Modifier.width(8.dp))
                    val hasDiscount = pkg.oldPrice != null && pkg.oldPrice > pkg.price
                    if (hasDiscount) {
                        Text(
                            "$${"%.2f".format(pkg.oldPrice)}",
                            color = MutedText,
                            fontSize = 12.sp,
                            textDecoration = TextDecoration.LineThrough,
                        )
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        "$${"%.2f".format(pkg.price)}",
                        color = if (hasDiscount) DalabGreen else MutedText,
                        fontWeight = if (hasDiscount) FontWeight.Bold else FontWeight.Normal,
                        fontSize = 12.sp,
                    )
                }
            }
        }

        Spacer(Modifier.height(gap))
        Text("Amount to Pay", color = MutedText, fontSize = 13.sp)
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                "$${"%.2f".format(pkg.price)}",
                color = DalabGreen,
                fontWeight = FontWeight.Black,
                fontSize = if (compact) 26.sp else 30.sp,
            )
            if (pkg.oldPrice != null && pkg.oldPrice > pkg.price) {
                Spacer(Modifier.width(10.dp))
                Text(
                    "$${"%.2f".format(pkg.oldPrice)}",
                    color = MutedText,
                    fontSize = if (compact) 15.sp else 17.sp,
                    textDecoration = TextDecoration.LineThrough,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
            }
        }

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
        Text("Payment Method", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
        Spacer(Modifier.height(if (compact) 8.dp else 12.dp))

        Surface(
            color = PanelBg,
            shape = RoundedCornerShape(16.dp),
            border = BorderStroke(1.dp, if (selectedWallet != null) DalabGreen else PanelBorder),
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = wallets.isNotEmpty()) { showPaymentSheet = true },
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val wallet = selectedWallet
                if (wallet != null) {
                    val walletLogo = remember(wallet.logoKey) { walletLogoRes(wallet.logoKey) }
                    Box(
                        modifier = Modifier
                            .size(if (compact) 36.dp else 42.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .background(remember(wallet.colorHex) { parseColorOrDefault(wallet.colorHex, DalabGreen) }),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (walletLogo != null) {
                            Image(painter = painterResource(walletLogo), contentDescription = wallet.name, modifier = Modifier.size(if (compact) 22.dp else 26.dp))
                        }
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(wallet.name, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                        wallet.providerLabel?.takeIf { it.isNotBlank() }?.let {
                            Text(it, color = MutedText, fontSize = 11.sp)
                        }
                    }
                    Text("Change", color = DalabGreen, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                } else {
                    Text(
                        if (walletsError != null) walletsError!!
                        else if (wallets.isEmpty()) "Loading payment methods..."
                        else "Select Payment Method",
                        color = MutedText,
                        fontSize = 13.sp,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        if (showPaymentSheet) {
            PaymentMethodSheet(
                wallets = wallets,
                onSelect = { selectedWallet = it; showPaymentSheet = false },
                onDismiss = { showPaymentSheet = false },
            )
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

        val payEnabled = selectedWallet != null && !submitting && !queued
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
                        paymentMethod = selectedWallet?.name,
                        clientRequestId = clientRequestId,
                    )
                    scope.launch {
                        try {
                            val response = RetryClassifier.requireSuccessful(ApiClient.service.createOrder(request))
                            val order = response.body()
                            if (order != null) {
                                val prefix = selectedWallet?.dialPrefix
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

private fun parseColorOrDefault(hex: String, fallback: Color): Color = try {
    Color(android.graphics.Color.parseColor(hex))
} catch (_: Exception) {
    fallback
}

/**
 * "Select Payment Method" bottom sheet — shows only wallets the Super Admin
 * has enabled (already filtered by the caller), fetched live from
 * GET /payment-wallets so a Super Admin toggle takes effect on the very
 * next checkout without an app update.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PaymentMethodSheet(wallets: List<PaymentWallet>, onSelect: (PaymentWallet) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = PanelBg,
    ) {
        Column(modifier = Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Text("Select Payment Method", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Spacer(Modifier.height(16.dp))
            wallets.forEach { wallet ->
                val walletLogo = remember(wallet.logoKey) { walletLogoRes(wallet.logoKey) }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .clickable { onSelect(wallet) }
                        .padding(vertical = 12.dp, horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .size(44.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(remember(wallet.colorHex) { parseColorOrDefault(wallet.colorHex, DalabGreen) }),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (walletLogo != null) {
                            Image(painter = painterResource(walletLogo), contentDescription = wallet.name, modifier = Modifier.size(28.dp))
                        }
                    }
                    Spacer(Modifier.width(14.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(wallet.name, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                        wallet.providerLabel?.takeIf { it.isNotBlank() }?.let {
                            Text(it, color = MutedText, fontSize = 12.sp)
                        }
                    }
                }
                Divider(color = PanelBorder, thickness = 1.dp)
            }
            if (wallets.isEmpty()) {
                Text("No payment methods are currently available.", color = MutedText, fontSize = 13.sp, modifier = Modifier.padding(vertical = 16.dp))
            }
        }
    }
}
