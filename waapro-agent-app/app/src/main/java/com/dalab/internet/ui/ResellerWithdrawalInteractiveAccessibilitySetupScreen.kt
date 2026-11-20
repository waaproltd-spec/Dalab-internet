package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccessibilityNew
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.dalab.internet.ussd.ResellerWithdrawalInteractiveUssdBridge

/**
 * Opt-in setup screen for Reseller Withdraw's interactive (eDahab-style
 * multi-step) automated payout engine — mirrors
 * ExchangeAccessibilitySetupScreen exactly, just pointed at
 * ResellerWithdrawalInteractiveUssdBridge's own separate accessibility
 * service. Reached from More > Reseller Withdraw Setup rather than from a
 * dedicated withdrawals list screen, since Reseller Withdraw payouts are
 * fully automatic/background (ResellerWithdrawalSelfHealSweeper) — there is
 * no per-order screen to hang this off of the way Money Exchange's own
 * setup entry hangs off ExchangeOrdersListScreen.
 *
 * Companies whose payout is Hormuud's one-shot combined dial string never
 * need this at all — it only matters for a company configured with the
 * interactive multi-step payout (reseller_withdrawal_interactive_payout_config,
 * migration 060), where it's the only way Android lets an app read and
 * reply to the carrier's own multi-screen USSD prompt automatically.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ResellerWithdrawalInteractiveAccessibilitySetupScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var enabled by remember { mutableStateOf(ResellerWithdrawalInteractiveUssdBridge.isAccessibilityServiceEnabled(context)) }

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                enabled = ResellerWithdrawalInteractiveUssdBridge.isAccessibilityServiceEnabled(context)
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val openSettings = {
        try {
            context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            // No handler on this ROM -- nothing more to do here.
        }
    }
    val ink = if (enabled) StatusGreen else StatusRed

    Scaffold(
        topBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(WaaproHeaderBrush, RoundedCornerShape(bottomStart = 26.dp, bottomEnd = 26.dp))
                    .padding(start = 8.dp, end = 16.dp, top = 10.dp, bottom = 18.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back", tint = Color.White) }
                    Text("Reseller Withdraw Setup", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp, maxLines = 1)
                }
                Spacer(Modifier.height(10.dp))
                Box(Modifier.padding(start = 8.dp)) {
                    StatusBanner(if (enabled) "Automatic payouts: ON" else "Automatic payouts: OFF", ok = enabled)
                }
            }
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // Status card.
            Surface(
                shape = RoundedCornerShape(22.dp),
                color = MaterialTheme.colorScheme.surface,
                shadowElevation = 2.dp,
                modifier = Modifier.fillMaxWidth().border(1.dp, ink.copy(alpha = 0.45f), RoundedCornerShape(22.dp)),
            ) {
                Column(Modifier.padding(18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.size(64.dp).clip(CircleShape).background(ink.copy(alpha = 0.12f)), contentAlignment = Alignment.Center) {
                        Icon(if (enabled) Icons.Filled.CheckCircle else Icons.Filled.AccessibilityNew, contentDescription = null, tint = ink, modifier = Modifier.size(36.dp))
                    }
                    Spacer(Modifier.height(10.dp))
                    Text(if (enabled) "Enabled" else "Not enabled", fontWeight = FontWeight.ExtraBold, fontSize = 20.sp, color = ink)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        if (enabled) "eDahab-style withdrawals are paid out automatically."
                        else "Turn on WAAPRO LTD AGENT in Accessibility to pay them out automatically.",
                        color = WaaproMuted, fontSize = 13.5.sp, textAlign = TextAlign.Center,
                    )
                    if (!enabled) {
                        Spacer(Modifier.height(14.dp))
                        Button(
                            onClick = openSettings,
                            colors = ButtonDefaults.buttonColors(containerColor = WaaproNavy),
                            shape = RoundedCornerShape(16.dp),
                            modifier = Modifier.fillMaxWidth().height(52.dp),
                        ) { Text("Open Accessibility Settings", fontWeight = FontWeight.Bold) }
                        Spacer(Modifier.height(6.dp))
                        Text("\"Restricted setting\"? Tap it and allow, then turn it on.", color = WaaproMuted, fontSize = 12.sp, textAlign = TextAlign.Center)
                    }
                }
            }

            // What the app does for each withdrawal, step by step.
            StatusSection("Each payout, automatically") {
                listOf(
                    Icons.Filled.SwapHoriz to "Choose Transfer",
                    Icons.Filled.Phone to "Enter the number",
                    Icons.Filled.Payments to "Enter the amount",
                    Icons.Filled.Lock to "Enter the reseller PIN",
                ).forEachIndexed { i, (icon, label) ->
                    if (i > 0) Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(32.dp).clip(CircleShape).background(WaaproNavy), contentAlignment = Alignment.Center) {
                            Text("${i + 1}", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 14.sp)
                        }
                        Spacer(Modifier.width(12.dp))
                        Icon(icon, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(label, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    }
                }
            }

            Row(verticalAlignment = Alignment.Top, modifier = Modifier.padding(horizontal = 4.dp)) {
                Icon(Icons.Filled.Info, contentDescription = null, tint = WaaproMuted, modifier = Modifier.size(16.dp).padding(top = 2.dp))
                Spacer(Modifier.width(8.dp))
                Text("Hormuud one-code payouts don't need this.", color = WaaproMuted, fontSize = 12.5.sp)
            }
        }
    }
}
