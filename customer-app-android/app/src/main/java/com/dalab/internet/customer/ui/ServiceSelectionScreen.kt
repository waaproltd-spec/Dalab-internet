package com.dalab.internet.customer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.prefs.LocalizationManager

private val ScreenBg = Color(0xFF0B0F1E)
private val PanelBg = Color(0xFF141A2E)
private val MutedText = Color(0xFF9CA3B8)
private val DalabGreen = Color(0xFF16A34A)
private val ExchangeBlue = Color(0xFF2E5BFF)

/**
 * The very first screen a customer sees: Internet vs Money Exchange. These
 * are two entirely separate main services — nothing about corridors,
 * wallets, or exchange orders ever appears inside the Internet flow, and no
 * package/company data ever appears inside the Money Exchange flow. Both
 * lead into their own independent stack of screens; this screen is the only
 * place they share.
 */
@Composable
fun ServiceSelectionScreen(onSelectInternet: () -> Unit, onSelectMoneyExchange: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(ScreenBg)
            .padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            LocalizationManager.tr("What would you like to do?", "Maxaad rabtaa inaad samayso?"),
            color = Color.White,
            fontWeight = FontWeight.Bold,
            fontSize = 22.sp,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            LocalizationManager.tr("Choose a service to get started", "Dooro adeeg si aad u bilowdo"),
            color = MutedText,
            fontSize = 13.sp,
        )
        Spacer(Modifier.height(28.dp))

        ServiceCard(
            emoji = "🌐",
            title = LocalizationManager.tr("Internet", "Interneetka"),
            subtitle = LocalizationManager.tr("Buy data, minutes, and SMS packages", "Iibso xirmooyinka data, daqiiqado iyo SMS"),
            accent = DalabGreen,
            onClick = onSelectInternet,
        )
        Spacer(Modifier.height(16.dp))
        ServiceCard(
            emoji = "💱",
            title = LocalizationManager.tr("Money Exchange", "Wareejinta Lacagta"),
            subtitle = LocalizationManager.tr("Exchange money between EVC Plus, eDahab, and more", "Ku wareeji lacagta EVC Plus, eDahab, iyo kuwo kale"),
            accent = ExchangeBlue,
            onClick = onSelectMoneyExchange,
        )
    }
}

@Composable
private fun ServiceCard(emoji: String, title: String, subtitle: String, accent: Color, onClick: () -> Unit) {
    Surface(
        color = PanelBg,
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(18.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(56.dp)
                    .background(Brush.linearGradient(listOf(accent, accent.copy(alpha = 0.6f))), RoundedCornerShape(16.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(emoji, fontSize = 26.sp)
            }
            Spacer(Modifier.width(16.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(title, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                Spacer(Modifier.height(2.dp))
                Text(subtitle, color = MutedText, fontSize = 12.sp)
            }
        }
    }
}
