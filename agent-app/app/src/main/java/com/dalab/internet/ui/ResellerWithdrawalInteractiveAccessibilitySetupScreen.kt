package com.dalab.internet.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.*
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

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Reseller Withdraw Setup") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).padding(20.dp).fillMaxSize()) {
            Icon(Icons.Filled.AccessibilityNew, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(48.dp))
            Spacer(Modifier.height(12.dp))
            Text(
                "Some Reseller Withdraw payout providers (like eDahab) use a multi-step USSD " +
                    "menu instead of a single combined code: select Transfer, enter the number, " +
                    "enter the amount, then enter the reseller PIN once the carrier asks for it. " +
                    "To complete that automatically instead of typing each step by hand, DALAB " +
                    "Agent needs the Accessibility permission — it's the only way Android lets an " +
                    "app read and reply to that on-screen carrier prompt.",
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(20.dp))

            if (enabled) {
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                    Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
                        Spacer(Modifier.width(10.dp))
                        Text("Enabled — automated multi-step Reseller Withdraw payouts are available.", color = MaterialTheme.colorScheme.onPrimaryContainer)
                    }
                }
            } else {
                Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text("Not enabled", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onErrorContainer)
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "Tap below, find \"DALAB Agent\" in the list, and turn it on. Some phones show " +
                                "a \"Restricted setting\" warning first for sideloaded apps — tap it, then " +
                                "follow the prompt to allow this setting.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                        )
                        Spacer(Modifier.height(10.dp))
                        Button(
                            onClick = {
                                try {
                                    context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                                } catch (_: ActivityNotFoundException) {
                                    // No handler on this ROM — nothing more to do here.
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("Open Accessibility Settings")
                        }
                    }
                }
            }

            Spacer(Modifier.height(16.dp))
            Text(
                "Without this, a withdrawal on an interactive-payout provider like eDahab stays " +
                    "reserved until an admin marks it Complete/Failed by hand — Hormuud-style " +
                    "one-shot payouts are unaffected either way.",
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}
