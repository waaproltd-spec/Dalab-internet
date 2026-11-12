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
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
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
    var copiedAgent by remember { mutableStateOf(false) }

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
            // Skipped while a Check Again is running: one request at a time.
            if (DeviceActivationState.status != Status.APPROVED && !checking) {
                checking = true
                DeviceActivationState.refresh()
                checking = false
            }
        }
    }
    // Sent back to "not activated" without a code (the server refused a
    // request): ask for this device's code straight away.
    LaunchedEffect(status, code) {
        if (status == Status.PENDING && code == null) DeviceActivationState.refresh()
    }
    LaunchedEffect(copiedCode) { if (copiedCode) { delay(2000); copiedCode = false } }
    LaunchedEffect(copiedId) { if (copiedId) { delay(2000); copiedId = false } }
    LaunchedEffect(copiedAgent) { if (copiedAgent) { delay(2000); copiedAgent = false } }

    fun copy(label: String, value: String) {
        context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(label, value))
    }

    // Agent ID (AGT-xxxxxxxx, as the dashboard shows it) read once.
    val agentId = remember {
        com.dalab.internet.auth.SessionManager.currentAgent()?.id?.takeIf { it.isNotBlank() }?.let { "AGT-" + it.take(8).uppercase() }
    }

    Box(Modifier.fillMaxSize().background(WaaproBg)) {
        WaaproWaves()
        Column(Modifier.fillMaxSize().systemBarsPadding()) {
            Column(
                modifier = Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 10.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // Sized to fit one phone screen without scrolling.
                WaaproLogoBlock(logoSize = 48.dp, nameSize = 19.sp)
                Spacer(Modifier.height(6.dp))
                WaaproAgentPill(textSize = 15.sp)
                Spacer(Modifier.height(10.dp))

                // Agent / device information, each with copy.
                InfoCard {
                    if (agentId != null) {
                        IdRow(label = "Agent ID", value = agentId, copied = copiedAgent) { copy("Agent ID", agentId); copiedAgent = true }
                    }
                    if (agentId != null && deviceNumber != null) {
                        Box(Modifier.fillMaxWidth().padding(vertical = 5.dp).height(1.dp).background(WaaproBorder))
                    }
                    IdRow(label = "Device ID", value = deviceNumber?.let { "ID $it" } ?: "ID …", copied = copiedId) {
                        if (deviceNumber != null) { copy("Device ID", deviceNumber); copiedId = true }
                    }
                }
                Spacer(Modifier.height(10.dp))

                if (status == Status.APPROVED) {
                    ActivatedState()
                } else {
                    InfoCard {
                        Row(verticalAlignment = Alignment.Top) {
                            Icon(Icons.Filled.VerifiedUser, contentDescription = null, tint = WaaproBlue, modifier = Modifier.size(38.dp))
                            Spacer(Modifier.width(12.dp))
                            Box(Modifier.width(2.dp).height(40.dp).background(WaaproNavy))
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text("Device Activation", color = WaaproNavy, fontSize = 20.sp, fontWeight = FontWeight.Black)
                                Spacer(Modifier.height(6.dp))
                                Text(
                                    "For security purposes, please contact your account manager and provide the following activation code:",
                                    color = WaaproInk,
                                    fontSize = 13.sp,
                                    lineHeight = 18.sp,
                                )
                            }
                        }
                        if (status == Status.PENDING && code != null) {
                            Spacer(Modifier.height(10.dp))
                            // The code, large, with copy.
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(18.dp))
                                    .background(Brush.horizontalGradient(listOf(WaaproBlue, WaaproNavy)))
                                    .clickable { copy("Activation code", code); copiedCode = true }
                                    .padding(start = 18.dp, end = 10.dp, top = 8.dp, bottom = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                androidx.compose.material3.Text(
                                    code,
                                    color = Color.White,
                                    fontSize = 40.sp,
                                    fontWeight = FontWeight.ExtraBold,
                                    letterSpacing = 6.sp,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.weight(1f),
                                )
                                Box(Modifier.width(1.dp).height(40.dp).background(Color.White.copy(alpha = 0.4f)))
                                Spacer(Modifier.width(10.dp))
                                Box(
                                    Modifier.size(44.dp).clip(RoundedCornerShape(12.dp)).background(Color.White.copy(alpha = 0.15f)),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(
                                        if (copiedCode) Icons.Filled.CheckCircle else Icons.Filled.ContentCopy,
                                        contentDescription = tr("Copy code"),
                                        tint = Color.White,
                                        modifier = Modifier.size(28.dp),
                                    )
                                }
                            }
                            if (copiedCode) {
                                Spacer(Modifier.height(8.dp))
                                Text("Code copied!", color = Color(0xFF16A34A), fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            }
                            DeviceActivationState.codeExpiresAt?.let {
                                Spacer(Modifier.height(10.dp))
                                Row(
                                    modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(WaaproSoft).padding(horizontal = 12.dp, vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Icon(Icons.Filled.CalendarMonth, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(20.dp))
                                    Spacer(Modifier.width(8.dp))
                                    Text(tr("Code expires") + ": ", color = WaaproInk, fontSize = 13.sp)
                                    androidx.compose.material3.Text(formatApiDateTime(it), color = WaaproNavy, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(10.dp))

                    val httpError = DeviceActivationState.lastHttpError
                    when {
                        DeviceActivationState.connectionError && httpError == null -> StatusCard(
                            icon = Icons.Filled.WifiOff,
                            tint = ErrorRed,
                            title = "No internet connection",
                            body = "Couldn't reach the server. Check your connection and tap Check Again to try again.",
                        )
                        httpError != null && httpError >= 500 -> StatusCard(
                            icon = Icons.Filled.CloudOff,
                            tint = ErrorRed,
                            title = "Server not responding",
                            body = tr("The server couldn't check this phone right now. Tap Check Again in a minute.") + " (HTTP $httpError)",
                        )
                        httpError != null -> StatusCard(
                            icon = Icons.Filled.ErrorOutline,
                            tint = ErrorRed,
                            title = "Couldn't check activation",
                            body = tr("The server refused the check. Tap Check Again; if it keeps happening, contact your admin.") + " (HTTP $httpError)",
                        )
                        status == Status.REJECTED -> StatusCard(
                            icon = Icons.Filled.ErrorOutline,
                            tint = ErrorRed,
                            title = "Device activation was rejected. Please contact your administrator.",
                            body = null,
                        )
                        status == Status.PENDING && checkedOnce -> StatusCard(
                            icon = Icons.Filled.AccessTime,
                            tint = WaitAmber,
                            title = "Your device is waiting for admin approval.",
                            body = "Please wait. Your device hasn't been approved yet.",
                        )
                        status == Status.UNKNOWN -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = WaaproBlue)
                        }
                        else -> {}
                    }
                }
                Spacer(Modifier.height(8.dp))
            }

            // Bottom action: Check Again (one check at a time), or Continue once approved.
            Button(
                onClick = { if (status == Status.APPROVED) onContinue() else check() },
                enabled = !checking,
                shape = RoundedCornerShape(50),
                contentPadding = PaddingValues(0.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent, disabledContainerColor = Color.Transparent),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).height(52.dp),
            ) {
                Box(
                    Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(WaaproBlue, WaaproNavy))),
                    contentAlignment = Alignment.Center,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (checking) {
                            CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
                            Spacer(Modifier.width(10.dp))
                            Text("Checking...", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                        } else if (status == Status.APPROVED) {
                            Text("Continue", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                            Spacer(Modifier.width(10.dp))
                            Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null, tint = Color.White)
                        } else {
                            Icon(Icons.Filled.Refresh, contentDescription = null, tint = Color.White)
                            Spacer(Modifier.width(10.dp))
                            Text("Check Again", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                        }
                    }
                }
            }
        }
    }
}

private val ErrorRed = Color(0xFFD6203A)
private val WaitAmber = Color(0xFFD97706)
private val ActGreen = Color(0xFF16A34A)

@Composable
private fun InfoCard(content: @Composable ColumnScope.() -> Unit) {
    Surface(
        color = Color.White,
        shape = RoundedCornerShape(20.dp),
        shadowElevation = 2.dp,
        border = BorderStroke(1.dp, WaaproSoft),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), horizontalAlignment = Alignment.CenterHorizontally, content = content)
    }
}

@Composable
private fun IdRow(label: String, value: String, copied: Boolean, onCopy: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Box(Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(WaaproSoft), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.PhoneAndroid, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.width(12.dp))
        Box(Modifier.width(1.dp).height(34.dp).background(WaaproBorder))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(label, color = WaaproMuted, fontSize = 12.sp)
            androidx.compose.material3.Text(value, color = WaaproNavy, fontSize = 18.sp, fontWeight = FontWeight.Black)
        }
        IconButton(
            onClick = onCopy,
            modifier = Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(WaaproSoft),
        ) {
            Icon(
                if (copied) Icons.Filled.CheckCircle else Icons.Filled.ContentCopy,
                contentDescription = tr("Copy") + " " + tr(label),
                tint = if (copied) ActGreen else WaaproNavy,
            )
        }
    }
}

@Composable
private fun ActivatedState() {
    Column(modifier = Modifier.fillMaxWidth().padding(top = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(modifier = Modifier.size(72.dp).background(ActGreen, CircleShape), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = Color.White, modifier = Modifier.size(48.dp))
        }
        Spacer(Modifier.height(20.dp))
        Text("Device activated!", color = WaaproNavy, fontWeight = FontWeight.Bold, fontSize = 22.sp)
        Spacer(Modifier.height(8.dp))
        Text(
            "Your device has been approved. Tap Continue to open the app.",
            color = WaaproMuted,
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
                Text(body, color = WaaproInk, fontSize = 14.sp)
            }
        }
    }
}
