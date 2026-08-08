package com.dalab.internet.customer.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.ContentCopy
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
import com.dalab.internet.customer.data.ExchangeOrder
import com.dalab.internet.customer.data.ExchangeWallet
import com.dalab.internet.customer.prefs.LocalizationManager
import com.dalab.internet.customer.util.ExchangeDialUtil

private val ScreenBg = Color(0xFF0B0F1E)
private val PanelBg = Color(0xFF141A2E)
private val PanelBorder = Color(0xFF232B45)
private val MutedText = Color(0xFF9CA3B8)
private val ExchangeBlue = Color(0xFF2E5BFF)

/**
 * Step 3 of Money Exchange: "Pay Now" — instructs the customer to send
 * amountSent to collectionPhoneNumber, and gives a one-tap dial button that
 * pre-fills (never auto-sends) the exact USSD string via ACTION_DIAL. The
 * order was already created (status 'pending') before this screen — Pay Now
 * doesn't create anything, it only helps the customer complete the payment
 * they already committed to. Continuing takes them to the live status
 * screen, which is where "pending" actually flips to "confirmed" once the
 * backend verifies the payment (SMS match or admin action) — this screen
 * itself never polls or claims the payment happened.
 */
@Composable
fun ExchangePaymentScreen(order: ExchangeOrder, fromWallet: ExchangeWallet?, onBack: () -> Unit, onContinue: () -> Unit) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxSize().background(ScreenBg)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
            }
            Text(LocalizationManager.tr("Payment Instructions", "Tilmaamaha Bixinta"), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            Spacer(Modifier.height(8.dp))
            Surface(
                shape = RoundedCornerShape(20.dp),
                modifier = Modifier.fillMaxWidth()
                    .background(Brush.linearGradient(listOf(ExchangeBlue, Color(0xFF1B3FCC))), RoundedCornerShape(20.dp)),
                color = Color.Transparent,
            ) {
                Column(modifier = Modifier.padding(20.dp)) {
                    Text(
                        LocalizationManager.tr("Send this exact amount to", "Ku dir lacagtan sax ah"),
                        color = Color.White.copy(alpha = 0.85f),
                        fontSize = 13.sp,
                    )
                    Spacer(Modifier.height(6.dp))
                    Text("$${"%.2f".format(order.amountSent)}", color = Color.White, fontWeight = FontWeight.Black, fontSize = 30.sp)
                }
            }

            Spacer(Modifier.height(16.dp))
            Surface(color = PanelBg, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, PanelBorder), modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(LocalizationManager.tr("Pay to this number", "Ku bixi lambarkan"), color = MutedText, fontSize = 12.sp)
                    Spacer(Modifier.height(4.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            order.collectionPhoneNumber ?: LocalizationManager.tr("Unavailable — contact support", "Ma jiro — la xiriir taageerada"),
                            color = Color.White,
                            fontWeight = FontWeight.Bold,
                            fontSize = 20.sp,
                        )
                        if (order.collectionPhoneNumber != null) {
                            Spacer(Modifier.width(8.dp))
                            IconButton(
                                onClick = {
                                    val clipboard = context.getSystemService(ClipboardManager::class.java)
                                    clipboard?.setPrimaryClip(ClipData.newPlainText("Collection number", order.collectionPhoneNumber))
                                    copied = true
                                },
                                modifier = Modifier.size(22.dp),
                            ) {
                                Icon(Icons.Filled.ContentCopy, contentDescription = "Copy", tint = MutedText, modifier = Modifier.size(16.dp))
                            }
                        }
                    }
                    if (copied) {
                        Spacer(Modifier.height(4.dp))
                        Text(LocalizationManager.tr("Copied", "Waa la koobiyeeyay"), color = ExchangeBlue, fontSize = 11.sp)
                    }
                    Spacer(Modifier.height(10.dp))
                    Divider(color = PanelBorder)
                    Spacer(Modifier.height(10.dp))
                    DetailRow(LocalizationManager.tr("Reference", "Tixraaca"), order.id)
                    DetailRow(LocalizationManager.tr("Recipient receives", "Qofka helaya wuxuu heli doonaa"), "$${"%.2f".format(order.amountReceived)}")
                    DetailRow(LocalizationManager.tr("Recipient number", "Lambarka qofka helaya"), order.receiverPhone)
                }
            }

            if (order.collectionPhoneNumber != null && fromWallet != null) {
                Spacer(Modifier.height(16.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp)
                        .clip(RoundedCornerShape(26.dp))
                        .background(Color(0xFF1B2240))
                        .clickable {
                            val intent = ExchangeDialUtil.resolveDialIntent(fromWallet.dialPrefix, order.collectionPhoneNumber, order.amountSent)
                            context.startActivity(intent)
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Call, contentDescription = null, tint = ExchangeBlue, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(10.dp))
                        Text(LocalizationManager.tr("Open dialer with amount pre-filled", "Fur diyaalka oo lacagta buuxi"), color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 14.dp)
                .height(54.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(Brush.horizontalGradient(listOf(ExchangeBlue, Color(0xFF1B3FCC))))
                .clickable(onClick = onContinue),
            contentAlignment = Alignment.Center,
        ) {
            Text(LocalizationManager.tr("I've Paid — Continue", "Waan bixiyay — Sii wad"), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = MutedText, fontSize = 12.sp)
        Text(value, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}
