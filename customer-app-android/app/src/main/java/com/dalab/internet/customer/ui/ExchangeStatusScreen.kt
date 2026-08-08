package com.dalab.internet.customer.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.HourglassTop
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.customer.data.ExchangeOrder
import com.dalab.internet.customer.data.ExchangeOrderStatus
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.RealtimeClient
import com.dalab.internet.customer.prefs.LocalizationManager
import kotlinx.coroutines.launch

private val ScreenBg = Color(0xFF0B0F1E)
private val PanelBg = Color(0xFF141A2E)
private val PanelBorder = Color(0xFF232B45)
private val MutedText = Color(0xFF9CA3B8)
private val ExchangeBlue = Color(0xFF2E5BFF)
private val DalabGreen = Color(0xFF16A34A)
private val WarnAmber = Color(0xFFF59E0B)

/**
 * Step 4 of Money Exchange: "Confirmation" / Exchange Status — the screen
 * this whole feature exists for. Exactly two customer-facing stages:
 *
 *  - PENDING           -> "Pay Now" (still waiting on the customer's payment)
 *  - everything else   -> "Confirmation" (IN_PROGRESS / COMPLETED both read
 *                          as "your payment went through," FAILED /
 *                          CANCELLED get their own honest message instead)
 *
 * This reads order.status straight from GET /exchange/orders/{id} — the
 * SAME status the automatic SMS-based payout-confirmation endpoint
 * (POST /agent/exchange/orders/payout-confirmation) can correct even when
 * the Agent App's own on-screen classification got it wrong. The customer
 * never sees anything about dial attempts, USSD, or the Agent App at all —
 * only this one order-level status, kept live via the same SSE stream
 * (/orders/stream) Internet Store's OrderDetailScreen already uses; the
 * backend broadcasts exchange_order.updated on that identical channel.
 */
@Composable
fun ExchangeStatusScreen(initialOrder: ExchangeOrder, onBack: () -> Unit, onDone: () -> Unit) {
    var order by remember { mutableStateOf(initialOrder) }
    val scope = rememberCoroutineScope()

    fun refresh() {
        scope.launch {
            try {
                ApiClient.service.getExchangeOrder(initialOrder.id).body()?.let { order = it }
            } catch (_: Exception) {
                // Leave previous state in place — the next SSE event (or the
                // periodic heartbeat keeping this connection alive) retries.
            }
        }
    }

    DisposableEffect(Unit) {
        val realtime = RealtimeClient(path = "orders/stream") { refresh() }
        realtime.connect()
        onDispose { realtime.disconnect() }
    }

    val confirmed = order.status != ExchangeOrderStatus.PENDING

    Column(modifier = Modifier.fillMaxSize().background(ScreenBg)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
            }
            Text(LocalizationManager.tr("Exchange Status", "Xaaladda Wareejinta"), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            Spacer(Modifier.height(12.dp))
            StageIndicator(confirmed = confirmed)

            Spacer(Modifier.height(20.dp))
            StatusBanner(order.status)

            Spacer(Modifier.height(20.dp))
            Surface(color = PanelBg, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, PanelBorder), modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    DetailRow(LocalizationManager.tr("Exchange Number", "Lambarka Wareejinta"), order.id)
                    DetailRow(LocalizationManager.tr("From", "Ka"), order.fromWalletName ?: "—")
                    DetailRow(LocalizationManager.tr("To", "Ku"), order.toWalletName ?: "—")
                    DetailRow(LocalizationManager.tr("Sending Number", "Lambarka Diraya"), order.senderPhone)
                    DetailRow(LocalizationManager.tr("Receiving Number", "Lambarka Helaya"), order.receiverPhone)
                    DetailRow(LocalizationManager.tr("Amount Sent", "Lacagta la Diray"), "$${"%.2f".format(order.amountSent)}")
                    DetailRow(LocalizationManager.tr("Exchange Rate", "Qiimaha Wareejinta"), "${order.rateApplied}")
                    DetailRow(LocalizationManager.tr("Exchange Fee", "Khidmadda Wareejinta"), "$${"%.2f".format(order.feeApplied)}")
                    DetailRow(LocalizationManager.tr("Amount Received", "Lacagta la Heli doono"), "$${"%.2f".format(order.amountReceived)}")
                }
            }
            Spacer(Modifier.height(16.dp))
        }

        if (confirmed) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 14.dp)
                    .height(54.dp)
                    .clip(RoundedCornerShape(28.dp))
                    .background(DalabGreen)
                    .clickable(onClick = onDone),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    LocalizationManager.tr("Done", "Dhammaystiran"),
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                )
            }
        }
    }
}

@Composable
private fun StageIndicator(confirmed: Boolean) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        StageDot(label = LocalizationManager.tr("Pay Now", "Bixi Hadda"), active = true, done = confirmed)
        StageConnector(filled = confirmed)
        StageDot(label = LocalizationManager.tr("Confirmation", "Xaqiijin"), active = confirmed, done = confirmed)
    }
}

@Composable
private fun RowScope.StageDot(label: String, active: Boolean, done: Boolean) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            modifier = Modifier.size(28.dp).background(if (active) (if (done) DalabGreen else ExchangeBlue) else PanelBorder, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (done) {
                Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
            } else {
                Text(if (active) "●" else "○", color = Color.White, fontSize = 12.sp)
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(label, color = if (active) Color.White else MutedText, fontSize = 11.sp, fontWeight = if (active) FontWeight.Bold else FontWeight.Normal)
    }
}

@Composable
private fun RowScope.StageConnector(filled: Boolean) {
    Box(
        modifier = Modifier
            .weight(1f)
            .height(2.dp)
            .padding(bottom = 20.dp)
            .background(if (filled) DalabGreen else PanelBorder),
    )
}

@Composable
private fun StatusBanner(status: ExchangeOrderStatus) {
    val (icon, color, text) = when (status) {
        ExchangeOrderStatus.PENDING -> Triple(
            Icons.Filled.HourglassTop, WarnAmber,
            LocalizationManager.tr("Waiting for your payment. Once we receive it, this will update automatically.", "Waxaan sugeynaa lacagtaada. Marka aan hesho, tani si toos ah ayay u cusboonaysiin doontaa."),
        )
        ExchangeOrderStatus.IN_PROGRESS -> Triple(
            Icons.Filled.CheckCircle, DalabGreen,
            LocalizationManager.tr("Payment confirmed! Your exchange is being sent to the recipient.", "Lacagta waa la xaqiijiyay! Wareejintaada waa loo dirayaa qofka helaya."),
        )
        ExchangeOrderStatus.COMPLETED -> Triple(
            Icons.Filled.CheckCircle, DalabGreen,
            LocalizationManager.tr("Payment confirmed! The recipient has received the money.", "Lacagta waa la xaqiijiyay! Qofka helayaa wuu heli lacagta."),
        )
        ExchangeOrderStatus.FAILED -> Triple(
            Icons.Filled.ErrorOutline, MaterialTheme.colorScheme.error,
            LocalizationManager.tr("We couldn't complete this exchange. Please contact support for assistance.", "Wareejintan lama dhamaystirin. Fadlan la xiriir taageerada."),
        )
        ExchangeOrderStatus.CANCELLED -> Triple(
            Icons.Filled.ErrorOutline, MutedText,
            LocalizationManager.tr("This exchange was cancelled.", "Wareejintan waa la joojiyay."),
        )
    }
    Surface(color = PanelBg, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, PanelBorder), modifier = Modifier.fillMaxWidth()) {
        Row(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(12.dp))
            Text(text, color = Color.White, fontSize = 13.sp)
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = MutedText, fontSize = 12.sp)
        Text(value, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}
