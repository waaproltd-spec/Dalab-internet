package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Shown on first launch (or any time READ_SMS/RECEIVE_SMS aren't granted),
 * before sign-in, for every system's agents (WAAPRO LTD branding only).
 * Two states:
 *  - Not yet asked  -> "Grant Permissions" triggers the OS runtime prompt.
 *  - Denied already -> the OS won't show the prompt again reliably; send the
 *    agent to the app's system settings page instead.
 * The permission request and the SMS processing behind it are unchanged.
 */
@Composable
fun SmsPermissionScreen(
    permanentlyDenied: Boolean,
    onRequestPermissions: () -> Unit,
) {
    val context = LocalContext.current

    Box(modifier = Modifier.fillMaxSize().background(WaaproBg)) {
        WaaproWaves()
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(12.dp))
            WaaproLogoBlock(logoSize = 92.dp, nameSize = 26.sp)
            Spacer(Modifier.height(10.dp))
            WaaproAgentPill(textSize = 19.sp)
            Spacer(Modifier.height(10.dp))
            Tagline()
            Spacer(Modifier.height(18.dp))

            SmsIllustration()
            Spacer(Modifier.height(16.dp))

            // "SMS Permission Required" banner
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(50))
                    .background(Brush.horizontalGradient(listOf(WaaproNavy, WaaproBlue)))
                    .padding(horizontal = 20.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = null, tint = Color.White, modifier = Modifier.size(24.dp))
                Spacer(Modifier.width(10.dp))
                Text("SMS Permission", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(6.dp))
                Text("Required", color = WaaproGold, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.height(14.dp))

            // What the app reads, and what it never reads.
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(18.dp))
                    .background(Color.White)
                    .border(1.dp, WaaproSoft, RoundedCornerShape(18.dp))
                    .padding(14.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    "$WAAPRO_APP_NAME reads payment-confirmation SMS (from Hormuud, Somtel, Somnet and Amtel) — both new messages as they arrive and any already in your inbox from the last 24 hours — so you can verify a customer's payment without leaving the app.",
                    color = WaaproInk,
                    fontSize = 14.sp,
                    textAlign = TextAlign.Center,
                    lineHeight = 20.sp,
                )
                Spacer(Modifier.height(10.dp))
                Row(
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(WaaproSoft).padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                ) {
                    Icon(Icons.Filled.Lock, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("It never reads or uploads any other message.", color = WaaproNavy, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                }
            }
            Spacer(Modifier.height(14.dp))

            // The four networks
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                NetworkCard(companyId = "hormuud", label = "Hormuud", modifier = Modifier.weight(1f))
                NetworkCard(companyId = "somtel", label = "Somtel", modifier = Modifier.weight(1f))
                NetworkCard(companyId = "somnet", label = "Somnet", modifier = Modifier.weight(1f))
                NetworkCard(companyId = "amtel", label = "Amtel", modifier = Modifier.weight(1f))
            }
            Spacer(Modifier.height(16.dp))

            // Privacy indicators
            Row(modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically) {
                PrivacyPoint(Icons.Filled.Sms, "Reads only\npayment SMS", Modifier.weight(1f))
                Box(Modifier.width(1.dp).fillMaxHeight().padding(vertical = 8.dp).background(WaaproBorder))
                PrivacyPoint(Icons.Filled.AccessTime, "Includes last\n24 hours", Modifier.weight(1f))
                Box(Modifier.width(1.dp).fillMaxHeight().padding(vertical = 8.dp).background(WaaproBorder))
                PrivacyPoint(Icons.Filled.Shield, "Your privacy\nis protected", Modifier.weight(1f))
            }
            Spacer(Modifier.height(20.dp))

            if (permanentlyDenied) {
                Surface(color = MaterialTheme.colorScheme.error.copy(alpha = 0.08f), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                    Text(
                        "Permission was denied. Please enable \"SMS\" for $WAAPRO_APP_NAME in system settings to continue.",
                        fontSize = 14.sp,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(14.dp),
                    )
                }
                Spacer(Modifier.height(12.dp))
                BigButton(icon = Icons.Filled.Settings, text = "Open App Settings") {
                    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = Uri.fromParts("package", context.packageName, null)
                    }
                    context.startActivity(intent)
                }
            } else {
                BigButton(icon = Icons.Filled.VerifiedUser, text = "Grant Permissions", onClick = onRequestPermissions)
            }
            Spacer(Modifier.height(70.dp))
        }
    }
}

@Composable
private fun Tagline() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(36.dp).height(2.dp).background(WaaproGold))
        Spacer(Modifier.width(10.dp))
        Text("Fudud", color = WaaproNavy, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Dot()
        Text("Degdeg", color = WaaproNavy, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Dot()
        Text("Amaan", color = WaaproNavy, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.width(10.dp))
        Box(Modifier.width(36.dp).height(2.dp).background(WaaproGold))
    }
}

@Composable
private fun Dot() {
    Box(Modifier.padding(horizontal = 8.dp).size(8.dp).background(WaaproGold, CircleShape))
}

/** A phone with a message and a green check, drawn with widgets (not an image). */
@Composable
private fun SmsIllustration() {
    Box(
        modifier = Modifier.size(150.dp).background(WaaproSoft, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Filled.Smartphone, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(112.dp))
        Box(
            modifier = Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)).background(Color.White),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Email, contentDescription = null, tint = WaaproBlue, modifier = Modifier.size(32.dp))
        }
        Box(
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 22.dp, bottom = 18.dp).size(40.dp).background(Color.White, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = Color(0xFF16A34A), modifier = Modifier.size(38.dp))
        }
    }
}

@Composable
private fun NetworkCard(companyId: String, label: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .shadow(2.dp, RoundedCornerShape(14.dp))
            .clip(RoundedCornerShape(14.dp))
            .background(Color.White)
            .padding(vertical = 10.dp, horizontal = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Image(
            painter = painterResource(logoResFor(companyId)),
            contentDescription = label,
            contentScale = ContentScale.Fit,
            modifier = Modifier.height(34.dp).fillMaxWidth(),
        )
        Spacer(Modifier.height(6.dp))
        Text(label, color = WaaproNavy, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
    }
}

@Composable
private fun PrivacyPoint(icon: ImageVector, text: String, modifier: Modifier = Modifier) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = modifier.padding(horizontal = 4.dp)) {
        Box(modifier = Modifier.size(40.dp).background(WaaproSoft, CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.height(6.dp))
        Text(text, color = WaaproInk, fontSize = 13.sp, textAlign = TextAlign.Center, lineHeight = 17.sp)
    }
}

@Composable
private fun BigButton(icon: ImageVector, text: String, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        shape = RoundedCornerShape(50),
        contentPadding = PaddingValues(0.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent),
        modifier = Modifier.fillMaxWidth().height(58.dp),
    ) {
        Box(
            Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(WaaproNavy, WaaproBlue))),
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, contentDescription = null, tint = Color.White)
                Spacer(Modifier.width(10.dp))
                Text(text, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(10.dp))
                Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null, tint = Color.White)
            }
        }
    }
}
