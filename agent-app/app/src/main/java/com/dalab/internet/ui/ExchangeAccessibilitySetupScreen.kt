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
import com.dalab.internet.ussd.ExchangeUssdBridge

/**
 * Opt-in setup screen for Money Exchange's automated payout engine — reached
 * from More > Money Exchange Setup, not shown at app launch (unlike
 * ReliabilitySetupScreen) since Money Exchange automation is optional: a
 * manual fallback (see ExchangeOrderDetailScreen) always remains available
 * without this being enabled.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExchangeAccessibilitySetupScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var enabled by remember { mutableStateOf(ExchangeUssdBridge.isAccessibilityServiceEnabled(context)) }

    // Android has no callback for "the user just enabled this from Settings" —
    // re-check whenever this screen resumes (i.e. the agent comes back from
    // the Settings screen this button opens).
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                enabled = ExchangeUssdBridge.isAccessibilityServiceEnabled(context)
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Money Exchange Setup") },
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
                "Money Exchange payouts use a two-step USSD flow: the carrier asks for a PIN " +
                    "after the amount and receiving number are sent. To complete that step " +
                    "automatically instead of typing the PIN by hand each time, DALAB Agent needs " +
                    "the Accessibility permission — it's the only way Android lets an app read and " +
                    "reply to that on-screen carrier prompt.",
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(20.dp))

            if (enabled) {
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                    Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
                        Spacer(Modifier.width(10.dp))
                        Text("Enabled — automated Money Exchange payouts are available.", color = MaterialTheme.colorScheme.onPrimaryContainer)
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
                "Without this, Money Exchange payouts still work — an agent can complete them " +
                    "manually from the order screen using the same USSD code and PIN.",
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}
