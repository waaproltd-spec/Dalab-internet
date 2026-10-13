package com.dalab.internet.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.auth.DeviceActivationState
import com.dalab.internet.auth.DeviceActivationState.Status
import com.dalab.internet.ui.i18n.Text
import com.dalab.internet.ui.i18n.tr
import com.dalab.internet.util.formatApiDateTime
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Fixed dark look from the reference design, independent of the app theme.
private val ActBg = Color(0xFF121418)
private val ActHeader = Color(0xFF1A1D23)
private val ActCard = Color(0xFF1E2128)
private val ActText = Color(0xFFF3F4F6)
private val ActMuted = Color(0xFFB4B9C4)
private val ActRed = Color(0xFFF2405C)
private val ActGreen = Color(0xFF22C55E)
private val ActAmber = Color(0xFFF59E0B)

/**
 * Device Activation: shown instead of the app until an admin approves this
 * install. Displays the device number and the 4-character code the agent
 * gives their account manager; Check (and a background poll every 10 s)
 * asks the backend for the real status -- the app only opens once the
 * backend says "approved".
 */
@Composable
fun DeviceActivationScreen(onContinue: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val status = DeviceActivationState.status
    val code = DeviceActivationState.code
    val deviceNumber = DeviceActivationState.deviceNumber
    var checking by remember { mutableStateOf(false) }
    var checkedOnce by remember { mutableStateOf(false) }
    var copiedCode by remember { mutableStateOf(false) }
    var copiedId by remember { mutableStateOf(false) }

    fun check() {
        if (checking) return
        checking = true
        scope.launch {
            DeviceActivationState.refresh()
            checkedOnce = true
            checking = false
        }
    }

    // First load, then a quiet poll for as long as this screen is shown, so
    // approval opens the app by itself. The poll never stops early: the
    // screen can stay up after an approval (waiting for Continue) and then
    // be sent back to "not activated" by the server, and it must fetch a
    // code again by itself instead of sitting there without one.
    LaunchedEffect(Unit) {
        DeviceActivationState.refresh()
        while (true) {
            delay(10_000)
            if (DeviceActivationState.status != Status.APPROVED) DeviceActivationState.refresh()
        }
    }
    // Sent back to "not activated" without a code (the server refused a
    // request): ask for this device's code straight away.
    LaunchedEffect(status, code) {
        if (status == Status.PENDING && code == null) DeviceActivationState.refresh()
    }
    LaunchedEffect(copiedCode) { if (copiedCode) { delay(2000); copiedCode = false } }
    LaunchedEffect(copiedId) { if (copiedId) { delay(2000); copiedId = false } }

    fun copy(label: String, value: String) {
        context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(label, value))
    }

    Column(modifier = Modifier.fillMaxSize().background(ActBg)) {
        // Header: brand, device number, copy device number.
        Box(modifier = Modifier.fillMaxWidth().background(ActHeader).statusBarsPadding().padding(vertical = 16.dp, horizontal = 16.dp)) {
            Column(modifier = Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("DALAB AGENT", color = ActText, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp)
                Spacer(Modifier.height(4.dp))
                Text(if (deviceNumber != null) "ID $deviceNumber" else "ID …", color = ActText, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            }
            if (deviceNumber != null) {
                IconButton(
                    onClick = { copy("Device ID", deviceNumber); copiedId = true },
                    modifier = Modifier.align(Alignment.CenterEnd),
                ) {
                    Icon(
                        if (copiedId) Icons.Filled.CheckCircle else Icons.Filled.ContentCopy,
                        contentDescription = "Copy device ID",
                        tint = if (copiedId) ActGreen else ActText,
                    )
                }
            }
        }

        Column(
            modifier = Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 18.dp),
        ) {
            if (status == Status.APPROVED) {
                ActivatedState()
            } else {
            Text("Device activation", color = ActText, fontWeight = FontWeight.Bold, fontSize = 20.sp)
            Spacer(Modifier.height(10.dp))
            val lead = tr("For security purposes, please contact your account manager and provide the following activation code:")
            androidx.compose.material3.Text(
                buildAnnotatedString {
                    append(lead)
                    if (code != null) {
                        append(" ")
                        withStyle(SpanStyle(fontWeight = FontWeight.ExtraBold, color = ActText)) { append(code) }
                    }
                },
                color = ActMuted,
                fontSize = 15.sp,
                lineHeight = 22.sp,
            )
            Spacer(Modifier.height(18.dp))

            if (status == Status.PENDING && code != null) {
                // The code, large, with copy.
                Box(
                    modifier = Modifier.fillMaxWidth().background(ActCard, RoundedCornerShape(16.dp))
                        .clickable { copy("Activation code", code); copiedCode = true }
                        .padding(vertical = 18.dp, horizontal = 18.dp),
                ) {
                    androidx.compose.material3.Text(
                        code,
                        color = ActText,
                        fontSize = 40.sp,
                        fontWeight = FontWeight.ExtraBold,
                        fontFamily = FontFamily.Monospace,
                        letterSpacing = 4.sp,
                        modifier = Modifier.align(Alignment.Center),
                    )
                    Icon(Icons.Filled.ContentCopy, contentDescription = "Copy code", tint = ActText, modifier = Modifier.align(Alignment.CenterEnd))
                }
                DeviceActivationState.codeExpiresAt?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        tr("Code expires") + ": " + formatApiDateTime(it),
                        color = ActMuted,
                        fontSize = 12.sp,
                        modifier = Modifier.fillMaxWidth(),
                        textAlign = TextAlign.Center,
                    )
                }
                if (copiedCode) {
                    Spacer(Modifier.height(12.dp))
                    Row(
                        modifier = Modifier.align(Alignment.CenterHorizontally).background(ActGreen, RoundedCornerShape(12.dp)).padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = Color.White)
                        Spacer(Modifier.width(8.dp))
                        Text("Code copied!", color = Color.White, fontWeight = FontWeight.Bold)
                    }
                }
                Spacer(Modifier.height(18.dp))
            }

            when {
                DeviceActivationState.connectionError -> StatusCard(
                    icon = Icons.Filled.WifiOff,
                    tint = ActRed,
                    title = "No internet connection",
                    body = "Couldn't reach the server. Check your connection and tap Check to try again.",
                )
                status == Status.REJECTED -> StatusCard(
                    icon = Icons.Filled.ErrorOutline,
                    tint = ActRed,
                    title = "Device activation was rejected. Please contact your administrator.",
                    body = null,
                )
                status == Status.PENDING && checkedOnce -> StatusCard(
                    icon = Icons.Filled.AccessTime,
                    tint = ActAmber,
                    title = "Your device is waiting for admin approval.",
                    body = "Please wait. Your device hasn't been approved yet.",
                )
                status == Status.UNKNOWN -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = ActText)
                }
                else -> ActivationIllustration()
            }
            }
        }

        // Bottom action: Check, or Continue once approved.
        Box(modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 16.dp)) {
            Button(
                onClick = { if (status == Status.APPROVED) onContinue() else check() },
                enabled = !checking,
                colors = ButtonDefaults.buttonColors(containerColor = ActRed, contentColor = Color.White, disabledContainerColor = ActRed.copy(alpha = 0.6f)),
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.fillMaxWidth().height(54.dp),
            ) {
                if (checking) {
                    CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                } else {
                    Text(if (status == Status.APPROVED) "Continue" else "Check", fontWeight = FontWeight.Bold, fontSize = 17.sp)
                }
            }
        }
    }
}

@Composable
private fun ActivatedState() {
    Column(modifier = Modifier.fillMaxWidth().padding(top = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(modifier = Modifier.size(72.dp).background(ActGreen, CircleShape), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = Color.White, modifier = Modifier.size(48.dp))
        }
        Spacer(Modifier.height(20.dp))
        Text("Device activated!", color = ActText, fontWeight = FontWeight.Bold, fontSize = 22.sp)
        Spacer(Modifier.height(8.dp))
        Text(
            "Your device has been approved. Tap Continue to open the app.",
            color = ActMuted,
            fontSize = 15.sp,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun StatusCard(icon: ImageVector, tint: Color, title: String, body: String?) {
    Surface(
        color = tint.copy(alpha = 0.12f),
        border = BorderStroke(1.dp, tint.copy(alpha = 0.5f)),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(28.dp))
                Spacer(Modifier.width(12.dp))
                Text(title, color = tint, fontWeight = FontWeight.Bold, fontSize = 16.sp)
            }
            if (body != null) {
                Spacer(Modifier.height(10.dp))
                Text(body, color = ActMuted, fontSize = 14.sp)
            }
        }
    }
}

/** Phone + support agent + "****" bubble, as in the reference design. */
@Composable
private fun ActivationIllustration() {
    Box(modifier = Modifier.fillMaxWidth().padding(top = 12.dp), contentAlignment = Alignment.Center) {
        Box(
            modifier = Modifier.size(width = 130.dp, height = 190.dp)
                .border(BorderStroke(3.dp, Color(0xFFB8C2E0)), RoundedCornerShape(22.dp))
                .background(Color(0xFF2A2F3A), RoundedCornerShape(22.dp)),
        ) {
            Box(
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 10.dp).size(8.dp).background(Color(0xFFB8C2E0), CircleShape),
            )
        }
        Row(
            modifier = Modifier.offset(x = (-30).dp, y = (-20).dp).background(Color(0xFF7C86B4), RoundedCornerShape(14.dp)).padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.SupportAgent, contentDescription = null, tint = Color.White, modifier = Modifier.size(30.dp))
            Spacer(Modifier.width(8.dp))
            Column {
                Box(Modifier.size(width = 40.dp, height = 4.dp).background(Color.White, RoundedCornerShape(2.dp)))
                Spacer(Modifier.height(5.dp))
                Box(Modifier.size(width = 28.dp, height = 4.dp).background(Color.White, RoundedCornerShape(2.dp)))
            }
        }
        Box(
            modifier = Modifier.offset(x = 30.dp, y = 40.dp).background(Color(0xFFE5E7EB), RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 8.dp),
        ) {
            androidx.compose.material3.Text("* * * *", color = Color(0xFF1F2937), fontWeight = FontWeight.ExtraBold, fontSize = 22.sp)
        }
    }
}
