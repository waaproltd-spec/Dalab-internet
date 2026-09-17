package com.dalab.internet.ui

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MarkEmailRead
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.dalab.internet.R
import com.dalab.internet.ui.theme.DalabDangerRed

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

    Box(modifier = Modifier.fillMaxSize().background(Color.White)) {
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(32.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(
                    painter = painterResource(R.drawable.dalab_logo),
                    contentDescription = null,
                    modifier = Modifier.size(44.dp).background(DalabIndigo, RoundedCornerShape(12.dp)).padding(4.dp),
                )
                Spacer(Modifier.width(10.dp))
                Column {
                    Row {
                        Text("DALAB", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold, color = DalabIndigo)
                        Spacer(Modifier.width(6.dp))
                        Text("Agent", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold, color = DalabSoftBlue2)
                    }
                }
            }
            Spacer(Modifier.height(4.dp))
            Text("Fudud • Degdeg • Amaan", style = MaterialTheme.typography.bodyMedium, color = Color(0xFF6B7280))

            Spacer(Modifier.height(28.dp))

            Box(modifier = Modifier.size(120.dp), contentAlignment = Alignment.Center) {
                Box(modifier = Modifier.size(120.dp).background(DalabSoftBlue.copy(alpha = 0.25f), CircleShape))
                Box(
                    modifier = Modifier.size(84.dp).background(DalabIndigo, RoundedCornerShape(22.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.MarkEmailRead, contentDescription = null, tint = Color.White, modifier = Modifier.size(42.dp))
                }
                Box(
                    modifier = Modifier.align(Alignment.BottomEnd).size(34.dp).background(DalabGreen, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp))
                }
            }

            Spacer(Modifier.height(24.dp))

            Row {
                Text("SMS ", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.ExtraBold, color = DalabIndigo)
                Text("permission required", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.ExtraBold, color = Color(0xFF111827))
            }

            Spacer(Modifier.height(14.dp))
            Text(
                "DALAB Agent reads payment-confirmation SMS (from Hormuud, Somtel, " +
                    "Somnet, and Amtel) — both new messages as they arrive and any " +
                    "already in your inbox from the last 24 hours — so you can verify " +
                    "a customer's payment without leaving the app. It never reads or " +
                    "uploads any other message.",
                style = MaterialTheme.typography.bodyMedium,
                color = Color(0xFF374151),
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(22.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                ProviderBadge(companyId = "hormuud", label = "Hormuud", modifier = Modifier.weight(1f))
                ProviderBadge(companyId = "somtel", label = "Somtel", modifier = Modifier.weight(1f))
                ProviderBadge(companyId = "somnet", label = "Somnet", modifier = Modifier.weight(1f))
                ProviderBadge(companyId = "amtel", label = "Amtel", modifier = Modifier.weight(1f))
            }

            Spacer(Modifier.height(20.dp))

            Row(horizontalArrangement = Arrangement.SpaceEvenly, modifier = Modifier.fillMaxWidth()) {
                FeaturePoint(icon = Icons.Filled.Sms, text = "Reads only\npayment SMS")
                FeaturePoint(icon = Icons.Filled.AccessTime, text = "Includes last\n24 hours")
                FeaturePoint(icon = Icons.Filled.Shield, text = "Your privacy\nis protected")
            }

            Spacer(Modifier.height(26.dp))

            if (permanentlyDenied) {
                Surface(color = DalabDangerRed.copy(alpha = 0.08f), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                    Text(
                        "Permission was denied. Please enable \"SMS\" for DALAB Agent in system settings to continue.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = DalabDangerRed,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(14.dp),
                    )
                }
                Spacer(Modifier.height(16.dp))
                Button(
                    onClick = {
                        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                            data = Uri.fromParts("package", context.packageName, null)
                        }
                        context.startActivity(intent)
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = DalabIndigo),
                    shape = RoundedCornerShape(999.dp),
                    modifier = Modifier.fillMaxWidth().height(54.dp),
                ) {
                    Text("Open App Settings", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                }
            } else {
                Button(
                    onClick = onRequestPermissions,
                    colors = ButtonDefaults.buttonColors(containerColor = DalabIndigo),
                    shape = RoundedCornerShape(999.dp),
                    modifier = Modifier.fillMaxWidth().height(54.dp),
                ) {
                    Text("Grant permissions", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.width(8.dp))
                    Icon(Icons.Filled.ArrowForward, contentDescription = null)
                }
            }

            Spacer(Modifier.height(14.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Lock, contentDescription = null, tint = Color(0xFF9CA3AF), modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    "We never read or upload any other message.",
                    style = MaterialTheme.typography.labelSmall,
                    color = Color(0xFF9CA3AF),
                )
            }

            Spacer(Modifier.height(28.dp))
        }

        Canvas(modifier = Modifier.fillMaxWidth().height(70.dp).align(Alignment.BottomCenter)) {
            val path = Path().apply {
                moveTo(0f, size.height * 0.55f)
                quadraticBezierTo(size.width * 0.25f, size.height * 0.1f, size.width * 0.5f, size.height * 0.45f)
                quadraticBezierTo(size.width * 0.75f, size.height * 0.85f, size.width, size.height * 0.35f)
                lineTo(size.width, size.height)
                lineTo(0f, size.height)
                close()
            }
            drawPath(path, color = DalabIndigo)
        }
    }
}

@Composable
private fun ProviderBadge(companyId: String, label: String, modifier: Modifier = Modifier) {
    Surface(color = Color.White, shape = RoundedCornerShape(14.dp), shadowElevation = 1.dp, modifier = modifier) {
        Column(modifier = Modifier.padding(vertical = 12.dp, horizontal = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Image(
                painter = painterResource(logoResFor(companyId)),
                contentDescription = label,
                contentScale = ContentScale.Fit,
                modifier = Modifier.height(22.dp).fillMaxWidth(),
            )
            Spacer(Modifier.height(6.dp))
            Text(label, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = DalabIndigo)
        }
    }
}

@Composable
private fun FeaturePoint(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(96.dp)) {
        Box(modifier = Modifier.size(38.dp).background(DalabSoftBlue.copy(alpha = 0.3f), CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = DalabIndigo, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.height(6.dp))
        Text(text, style = MaterialTheme.typography.labelSmall, color = Color(0xFF6B7280), textAlign = TextAlign.Center)
    }
}

// A slightly deeper blue for the "Agent" half of the wordmark, distinct
// from DalabIndigo (the "DALAB" half + every button/accent on this screen)
// -- purely typographic, not a new brand color introduced elsewhere.
private val DalabSoftBlue2 = Color(0xFF2563A8)
