package com.dalab.internet.customer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.data.ExchangeCorridor
import com.dalab.internet.customer.data.ExchangeWallet
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.prefs.LocalizationManager

private val ScreenBg = Color(0xFF0B0F1E)
private val PanelBg = Color(0xFF141A2E)
private val PanelBorder = Color(0xFF232B45)
private val MutedText = Color(0xFF9CA3B8)
private val ExchangeBlue = Color(0xFF2E5BFF)

/**
 * Money Exchange's own entry screen, entirely separate from Internet
 * Store's HomeScreen (company list) — a corridor already encodes both the
 * From and To wallet as one pair (e.g. "eDahab -> EVC Plus"), so there's no
 * separate From/To dropdown here; picking a corridor picks both at once.
 */
@Composable
fun ExchangeCorridorsScreen(onBack: () -> Unit, onSelectCorridor: (ExchangeCorridor, ExchangeWallet?, ExchangeWallet?) -> Unit) {
    var corridors by remember { mutableStateOf<List<ExchangeCorridor>>(emptyList()) }
    var wallets by remember { mutableStateOf<List<ExchangeWallet>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            corridors = ApiClient.service.getExchangeCorridors().body().orEmpty().filter { it.enabled }
            wallets = ApiClient.service.getExchangeWallets().body().orEmpty()
        } catch (e: Exception) {
            error = "Couldn't load exchange corridors. Please try again."
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
            Text(LocalizationManager.tr("Money Exchange", "Wareejinta Lacagta"), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        }

        Column(modifier = Modifier.padding(horizontal = 20.dp).weight(1f)) {
            Spacer(Modifier.height(4.dp))
            Text(
                LocalizationManager.tr("Choose an exchange", "Dooro wareejinta aad rabto"),
                color = MutedText,
                fontSize = 13.sp,
            )
            Spacer(Modifier.height(16.dp))

            when {
                loading -> Text(LocalizationManager.tr("Loading...", "Waa la soo raadinayaa..."), color = MutedText, fontSize = 13.sp)
                error != null -> Text(error!!, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
                corridors.isEmpty() -> Text(
                    LocalizationManager.tr("No exchange corridors are available right now.", "Hadda ma jiraan wareejin diyaar ah."),
                    color = MutedText,
                    fontSize = 13.sp,
                )
                else -> LazyColumn {
                    items(corridors) { corridor ->
                        val fromWallet = wallets.firstOrNull { it.id == corridor.fromWalletId }
                        val toWallet = wallets.firstOrNull { it.id == corridor.toWalletId }
                        CorridorCard(
                            corridor = corridor,
                            fromWallet = fromWallet,
                            toWallet = toWallet,
                            onClick = { onSelectCorridor(corridor, fromWallet, toWallet) },
                        )
                        Spacer(Modifier.height(12.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun CorridorCard(corridor: ExchangeCorridor, fromWallet: ExchangeWallet?, toWallet: ExchangeWallet?, onClick: () -> Unit) {
    Surface(
        color = PanelBg,
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WalletBadge(fromWallet?.name ?: corridor.fromWalletName ?: "?", fromWallet?.colorHex)
            Spacer(Modifier.width(10.dp))
            Icon(Icons.Filled.ArrowForward, contentDescription = null, tint = MutedText, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(10.dp))
            WalletBadge(toWallet?.name ?: corridor.toWalletName ?: "?", toWallet?.colorHex)
            Spacer(Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "${fromWallet?.name ?: corridor.fromWalletName ?: "?"} → ${toWallet?.name ?: corridor.toWalletName ?: "?"}",
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    LocalizationManager.tr("Rate", "Qiimaha") + ": ${corridor.rate}",
                    color = MutedText,
                    fontSize = 12.sp,
                )
            }
        }
    }
}

@Composable
private fun WalletBadge(name: String, colorHex: String?) {
    val color = colorHex?.let { parseColorOrDefault(it, ExchangeBlue) } ?: ExchangeBlue
    Box(
        modifier = Modifier.size(36.dp).background(color, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(name.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp)
    }
}
