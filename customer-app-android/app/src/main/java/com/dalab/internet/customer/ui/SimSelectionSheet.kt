package com.dalab.internet.customer.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.telephony.SubscriptionManager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SimCard
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat

/** One physical SIM slot actually inserted right now, with its real carrier
 * name (e.g. "Hormuud Telecom") — read via SubscriptionManager, never
 * hardcoded. */
data class DetectedSim(val slotIndex: Int, val carrierName: String)

/** Reads the device's currently-active SIMs. Requires READ_PHONE_STATE
 * (requested at runtime only when this dialog would actually be shown);
 * returns an empty list (never throws) if the permission isn't granted or
 * the device genuinely has 0/1 SIMs — callers should treat "not exactly 2"
 * as "just dial directly, no picker needed." */
fun detectActiveSims(context: Context): List<DetectedSim> {
    val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
    if (!granted) return emptyList()
    val subscriptionManager = context.getSystemService(SubscriptionManager::class.java) ?: return emptyList()
    val infos = try {
        subscriptionManager.activeSubscriptionInfoList
    } catch (_: SecurityException) {
        null
    } ?: return emptyList()
    return infos.map {
        DetectedSim(
            slotIndex = it.simSlotIndex,
            carrierName = it.carrierName?.toString()?.takeIf { name -> name.isNotBlank() }
                ?: it.displayName?.toString()?.takeIf { name -> name.isNotBlank() }
                ?: "SIM ${it.simSlotIndex + 1}",
        )
    }.sortedBy { it.slotIndex }
}

/**
 * Second bottom sheet in the payment flow, shown only when exactly 2 active
 * SIMs are detected — lets the customer pick which SIM to dial with (e.g.
 * "SIM 1: Hormuud Telecom", "SIM 2: SOMTEL"). Dialing itself always goes
 * through the customer's own ACTION_DIAL tap afterward (never a forced
 * PhoneAccountHandle/SIM override) — a wrong-SIM dial guessed via an
 * unreliable OEM-specific heuristic would be a worse outcome for a payment
 * flow than letting Android's own native dialer prompt for the SIM when the
 * customer actually presses call, which every dual-SIM Android phone already
 * does on its own.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SimSelectionSheet(sims: List<DetectedSim>, onDismiss: () -> Unit, onSimSelected: (DetectedSim) -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
            Text("Choose SIM Card", fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Spacer(Modifier.height(4.dp))
            Text(
                "Select which SIM to use to send this payment",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(16.dp))
            sims.forEach { sim ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(PaymentGreen.copy(alpha = 0.08f))
                        .clickable { onSimSelected(sim) }
                        .padding(horizontal = 16.dp, vertical = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier.size(36.dp).clip(CircleShape).background(PaymentGreen.copy(alpha = 0.16f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Filled.SimCard, contentDescription = null, tint = PaymentGreen, modifier = Modifier.size(18.dp))
                    }
                    Spacer(Modifier.width(14.dp))
                    Text("SIM ${sim.slotIndex + 1}: ${sim.carrierName}", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                }
                Spacer(Modifier.height(10.dp))
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}
