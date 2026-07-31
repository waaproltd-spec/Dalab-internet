package com.sahal.data.ui

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * Shown on first launch (or any time READ_SMS/RECEIVE_SMS aren't granted). Two
 * distinct states per the spec:
 *  - Not yet asked  -> "Grant permissions" triggers the OS runtime prompt.
 *  - Denied already -> OS won't show the prompt again reliably; send the agent to
 *    the app's system settings page instead.
 */
@Composable
fun SmsPermissionScreen(
    permanentlyDenied: Boolean,
    onRequestPermissions: () -> Unit,
) {
    val context = LocalContext.current

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            "SMS permission required",
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(16.dp))
        Text(
            "Sahal Data Agent reads payment-confirmation SMS (from Hormuud, Somtel, " +
                "Somnet, and Amtel) — both new messages as they arrive and any " +
                "already in your inbox from the last 24 hours — so you can verify " +
                "a customer's payment without leaving the app. It never reads or " +
                "uploads any other message.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(28.dp))

        if (permanentlyDenied) {
            Text(
                "Permission was denied. Please enable \"SMS\" for Sahal Data Agent in " +
                    "system settings to continue.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
            Spacer(Modifier.height(16.dp))
            Button(onClick = {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", context.packageName, null)
                }
                context.startActivity(intent)
            }) {
                Text("Open App Settings")
            }
        } else {
            Button(onClick = onRequestPermissions) {
                Text("Grant permissions")
            }
        }
    }
}
