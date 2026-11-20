package com.dalab.internet.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.SimCard
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.data.SimBalance
import com.dalab.internet.ui.i18n.Text

private val ErrRed = Color(0xFFB42318)
private val ErrBg = Color(0xFFFDE2E2)
private val WarnInk = Color(0xFF8A6200)
private val WarnBg = Color(0xFFFFF4D6)

private val NETWORK_ORDER = listOf("Hormuud", "Somnet", "Somtel", "Amtel")

/** Money with two decimals, or null for "no confirmed balance". */
fun simBalanceText(balance: Double?): String? = balance?.let { "$" + "%.2f".format(it) }

/** "Updated 5 min ago · SMS"; null when there's no update time. */
fun simUpdatedText(iso: String?, source: String?, now: java.time.Instant = java.time.Instant.now()): String? {
    val ago = lastSeenText(iso, now) ?: return null
    val how = when (source) {
        "sms" -> " · SMS"
        "ussd_dial" -> " · USSD reply"
        "manual" -> " · entered by admin"
        else -> ""
    }
    return "Updated $ago$how"
}

/**
 * Home: every SIM the admin configured, grouped by network, each with its
 * own number, phone and slot, and its confirmed balance -- or the real
 * reason there is none (never a made-up $0). The total adds only
 * confirmed balances and says how many SIMs have none.
 */
@Composable
fun SimBalancesSection(sims: List<SimBalance>, loading: Boolean, error: String?) {
    val known = sims.filter { it.balance != null }
    val unknown = sims.size - known.size
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
        Row(
            Modifier.fillMaxWidth().background(WaaproHeaderBrush, RoundedCornerShape(16.dp)).padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("SIM balances", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Text(
                    if (loading) "…" else if (unknown > 0) "${sims.size} SIMs · $unknown without a balance yet" else "${sims.size} SIMs",
                    color = Color.White.copy(alpha = 0.8f), fontSize = 12.sp,
                )
            }
            Text(if (loading) "…" else simBalanceText(known.sumOf { it.balance ?: 0.0 })!!, color = WaaproGold, fontWeight = FontWeight.Black, fontSize = 22.sp)
        }
        error?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, color = ErrRed, fontSize = 12.sp)
        }
        if (!loading && sims.isEmpty()) {
            Spacer(Modifier.height(10.dp))
            Text("No SIM has been set up by the admin yet (Balance Dashboard / SIM Routing).", color = WaaproMuted, fontSize = 13.sp)
        }
        val groups = sims.groupBy { it.network }.toList()
            .sortedBy { (n, _) -> NETWORK_ORDER.indexOf(n).let { if (it < 0) 99 else it } }
        groups.forEach { (network, list) ->
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(network, color = WaaproNavy, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp, modifier = Modifier.weight(1f))
                val sum = list.mapNotNull { it.balance }
                if (sum.isNotEmpty()) Text(simBalanceText(sum.sum())!!, color = WaaproNavy, fontWeight = FontWeight.Bold, fontSize = 14.sp)
            }
            Spacer(Modifier.height(6.dp))
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { list.forEach { SimBalanceRow(it) } }
        }
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
fun SimBalanceRow(s: SimBalance) {
    val problem = s.status != "ok"
    val hard = s.status == "sim_missing" || s.status == "no_balance_yet"
    Surface(shape = RoundedCornerShape(14.dp), color = Color.White, modifier = Modifier.fillMaxWidth().border(1.dp, WaaproBorder, RoundedCornerShape(14.dp))) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.SimCard, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(s.label, color = WaaproNavy, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                    Text(
                        listOfNotNull(s.phoneNumber, listOfNotNull(s.deviceName, "SIM ${s.simSlot}").joinToString(" · ")).joinToString("  ·  "),
                        color = WaaproMuted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                val text = simBalanceText(s.balance)
                if (text != null) {
                    Text(text, color = if (problem) WarnInk else WaaproNavy, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp)
                } else {
                    Text("Unknown", color = ErrRed, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                }
            }
            simUpdatedText(s.updatedAt, s.source)?.let { Text(it, color = WaaproMuted, fontSize = 11.5.sp, modifier = Modifier.padding(start = 28.dp, top = 2.dp)) }
            if (problem && s.message != null) {
                Spacer(Modifier.height(6.dp))
                Row(
                    Modifier.fillMaxWidth().background(if (hard) ErrBg else WarnBg, RoundedCornerShape(10.dp)).padding(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.ErrorOutline, contentDescription = null, tint = if (hard) ErrRed else WarnInk, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(s.message, color = if (hard) ErrRed else WarnInk, fontSize = 12.sp)
                }
            }
        }
    }
}
