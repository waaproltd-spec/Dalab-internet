package com.dalab.internet.customer.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.data.PaymentWallet
import com.dalab.internet.customer.data.walletLogoRes
import com.dalab.internet.customer.network.ApiClient

private val DalabGreen = Color(0xFF16A34A)
private val ScreenBg = Color(0xFF0B0F1E)
private val PanelBg = Color(0xFF141A2E)
private val PanelBorder = Color(0xFF232B45)
private val MutedText = Color(0xFF9CA3B8)

/**
 * Step 2 of checkout — "Select Payment Method". Only wallets the Super
 * Admin has enabled are shown, fetched live from GET /payment-wallets (never
 * hardcoded). Selecting one advances to Confirm Order (Step 3), which no
 * longer needs to show a payment method picker since it's already chosen.
 *
 * Wallets are GLOBAL (evc_plus/edahab/jeeb/amtel_pay, no company_id), but
 * CheckoutScreen combines the selected wallet's dialPrefix with THIS
 * company's own paymentNumber to build the dial string — so showing a
 * wallet that doesn't belong to `company` would let the customer combine
 * one provider's USSD prefix with a different provider's payment number,
 * dialing a string that matches neither. Filter down to the wallet(s) whose
 * providerLabel matches this company (seeded 1:1, e.g. "Somtel" -> eDahab).
 */
@Composable
fun PaymentMethodScreen(company: Company, pkg: PackageItem, onBack: () -> Unit, onSelect: (PaymentWallet) -> Unit) {
    var wallets by remember { mutableStateOf<List<PaymentWallet>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }

    LaunchedEffect(company.id) {
        try {
            val all = ApiClient.service.getPaymentWallets().body().orEmpty().filter { it.enabled }
            wallets = all.filter { it.providerLabel?.equals(company.name, ignoreCase = true) == true }
        } catch (e: Exception) {
            error = "Couldn't load payment methods. Please try again."
        }
        loading = false
    }

    Column(modifier = Modifier.fillMaxSize().background(ScreenBg)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
            }
            Text("Select Payment Method", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        }

        Column(modifier = Modifier.padding(horizontal = 20.dp)) {
            Spacer(Modifier.height(4.dp))
            Text(
                "${pkg.name} • $${"%.2f".format(pkg.price)}",
                color = MutedText,
                fontSize = 13.sp,
            )
            Spacer(Modifier.height(20.dp))

            when {
                loading -> Text("Loading payment methods...", color = MutedText, fontSize = 13.sp)
                error != null -> Text(error!!, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
                wallets.isEmpty() -> Text("No payment method is set up for ${company.name} yet. Please contact support.", color = MutedText, fontSize = 13.sp)
                else -> wallets.forEach { wallet ->
                    val walletLogo = remember(wallet.logoKey) { walletLogoRes(wallet.logoKey) }
                    Surface(
                        color = PanelBg,
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 12.dp)
                            .clickable { onSelect(wallet) },
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(44.dp)
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(parseColorOrDefault(wallet.colorHex, DalabGreen)),
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
                    }
                }
            }
        }
    }
}
