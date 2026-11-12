package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import com.dalab.internet.ui.i18n.tr
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Login
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.R
import com.dalab.internet.auth.HubLogin
import com.dalab.internet.auth.HubLoginResult
import com.dalab.internet.auth.SignedInSystem
import kotlinx.coroutines.launch

// WAAPRO LTD colours (the logo's navy and gold).
private val WaaproNavy = Color(0xFF0B2A6B)
private val WaaproBlue = Color(0xFF1565D8)
private val WaaproGold = Color(0xFFF5B800)
private val LoginBg = Color(0xFFF4F7FC)
private val FieldBorder = Color(0xFFD5DCE8)
private val Muted = Color(0xFF5B6475)

/**
 * The phone number as the agent types it: digits only, at most 9, with the
 * country code +252 shown fixed in front (never typed). A pasted
 * "+252 61 ...", "252...", "00252..." or "061..." is reduced to its 9
 * digits. The same 9-digit local number is what the Admin Hub and every
 * system (DALAB, Danwadaag, Fududeeye, Sahal) match agents on.
 */
internal fun localPhoneInput(raw: String): String {
    var d = raw.filter { it.isDigit() }
    if (d.length > 9) {
        d = when {
            d.startsWith("00252") -> d.removePrefix("00252")
            d.startsWith("252") -> d.removePrefix("252")
            d.startsWith("0") -> d.removePrefix("0")
            else -> d
        }
    }
    return d.take(9)
}

internal fun isValidLocalPhone(digits: String): Boolean = digits.length == 9 && digits.all { it.isDigit() }

/**
 * The one sign-in screen of the AGENT APP for every system: phone number +
 * PIN, no system picker. The Admin Hub finds the agent's system; nothing on
 * this screen ever names a system before the sign-in succeeds.
 */
@Composable
fun AgentLoginScreen(onSignedIn: (SignedInSystem) -> Unit) {
    var phone by rememberSaveable { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var showPin by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var phoneTouched by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current

    val phoneOk = isValidLocalPhone(phone)
    val canSubmit = !busy && phoneOk && pin.isNotEmpty()

    fun submit() {
        if (!canSubmit) return
        focus.clearFocus()
        busy = true
        error = null
        scope.launch {
            when (val result = HubLogin.signIn(phone, pin)) {
                is HubLoginResult.Success -> {
                    pin = ""
                    onSignedIn(result.system)
                }
                is HubLoginResult.Failure -> error = result.message
            }
            busy = false
        }
    }

    Box(Modifier.fillMaxSize().background(LoginBg)) {
        LoginWaves()
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 40.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(24.dp))
            // The official WAAPRO LTD logo, unchanged (res/drawable/waapro_ltd_logo.png).
            Image(
                painter = painterResource(R.drawable.waapro_ltd_logo),
                contentDescription = "WAAPRO LTD",
                modifier = Modifier.size(132.dp),
            )
            Text("WAAPRO LTD", color = WaaproNavy, fontSize = 30.sp, fontWeight = FontWeight.Black, letterSpacing = 0.5.sp)
            Spacer(Modifier.height(8.dp))
            Box(Modifier.width(72.dp).height(4.dp).clip(RoundedCornerShape(2.dp)).background(WaaproGold))
            Spacer(Modifier.height(20.dp))

            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(Brush.horizontalGradient(listOf(WaaproNavy, WaaproBlue)))
                    .padding(horizontal = 26.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.SupportAgent, contentDescription = null, tint = Color.White, modifier = Modifier.size(28.dp))
                Spacer(Modifier.width(10.dp))
                Text("Agent App", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.height(14.dp))
            Text("Sign in with your phone number and PIN.", color = Color(0xFF1B2333), fontSize = 15.sp, textAlign = TextAlign.Center)
            Spacer(Modifier.height(22.dp))

            // Phone: +252 fixed, then exactly 9 digits.
            val showPhoneError = phoneTouched && phone.isNotEmpty() && !phoneOk
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(Color.White)
                    .border(1.dp, if (showPhoneError) MaterialTheme.colorScheme.error else FieldBorder, RoundedCornerShape(16.dp))
                    .padding(start = 14.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Phone, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    "+252",
                    color = WaaproNavy,
                    fontWeight = FontWeight.Bold,
                    fontSize = 17.sp,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Color(0xFFE3EEFD)).padding(horizontal = 10.dp, vertical = 6.dp),
                )
                Spacer(Modifier.width(8.dp))
                Box(Modifier.width(1.dp).height(30.dp).background(FieldBorder))
                TextField(
                    value = phone,
                    onValueChange = { v ->
                        phone = localPhoneInput(v)
                        if (phone.length == 9) phoneTouched = true
                    },
                    placeholder = { Text("9 digit phone number", color = Muted) },
                    singleLine = true,
                    enabled = !busy,
                    textStyle = TextStyle(fontSize = 17.sp, color = Color(0xFF1B2333), letterSpacing = 0.5.sp),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { phoneTouched = true; focus.moveFocus(androidx.compose.ui.focus.FocusDirection.Down) }),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = Color.Transparent,
                        unfocusedContainerColor = Color.Transparent,
                        disabledContainerColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        disabledIndicatorColor = Color.Transparent,
                        cursorColor = WaaproBlue,
                    ),
                    modifier = Modifier.weight(1f),
                )
            }
            Spacer(Modifier.height(6.dp))
            Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.Info,
                    contentDescription = null,
                    tint = if (showPhoneError) MaterialTheme.colorScheme.error else WaaproNavy,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    if (showPhoneError) "The phone number must be exactly 9 digits." else "Enter your Somali phone number (9 digits) after +252.",
                    color = if (showPhoneError) MaterialTheme.colorScheme.error else WaaproNavy,
                    fontSize = 13.sp,
                )
            }
            Spacer(Modifier.height(14.dp))

            // PIN, with show/hide.
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(Color.White)
                    .border(1.dp, FieldBorder, RoundedCornerShape(16.dp))
                    .padding(start = 14.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Lock, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(22.dp))
                TextField(
                    value = pin,
                    onValueChange = { v -> pin = v.filter { it.isDigit() }.take(8) },
                    placeholder = { Text("PIN", color = Muted) },
                    singleLine = true,
                    enabled = !busy,
                    visualTransformation = if (showPin) VisualTransformation.None else PasswordVisualTransformation(),
                    textStyle = TextStyle(fontSize = 17.sp, color = Color(0xFF1B2333)),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { phoneTouched = true; submit() }),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = Color.Transparent,
                        unfocusedContainerColor = Color.Transparent,
                        disabledContainerColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        disabledIndicatorColor = Color.Transparent,
                        cursorColor = WaaproBlue,
                    ),
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { showPin = !showPin }) {
                    Icon(
                        if (showPin) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                        contentDescription = tr(if (showPin) "Hide PIN" else "Show PIN"),
                        tint = WaaproNavy,
                    )
                }
            }

            if (error != null) {
                Spacer(Modifier.height(14.dp))
                Text(error!!, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
            }

            Spacer(Modifier.height(22.dp))
            Button(
                onClick = { phoneTouched = true; submit() },
                enabled = canSubmit,
                shape = RoundedCornerShape(50),
                contentPadding = PaddingValues(0.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent, disabledContainerColor = Color.Transparent),
                modifier = Modifier.fillMaxWidth().height(56.dp),
            ) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(
                            if (canSubmit || busy) Brush.horizontalGradient(listOf(WaaproBlue, WaaproNavy))
                            else Brush.horizontalGradient(listOf(Color(0xFFB7C3D9), Color(0xFF9AA8C2))),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (busy) {
                            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(22.dp), color = Color.White)
                            Spacer(Modifier.width(10.dp))
                            Text("Signing in...", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                        } else {
                            Icon(Icons.AutoMirrored.Filled.Login, contentDescription = null, tint = Color.White)
                            Spacer(Modifier.width(10.dp))
                            Text("Sign in", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }

            Spacer(Modifier.height(20.dp))
            Row(
                modifier = Modifier.clip(RoundedCornerShape(50)).background(Color(0xFFE8EDF6)).padding(horizontal = 18.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.VerifiedUser, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Forgot your PIN? Ask your admin.", color = WaaproNavy, fontSize = 14.sp)
            }
            Spacer(Modifier.height(60.dp))
        }
    }
}

/** The navy-and-gold curves at the top-left and bottom of the sign-in screen. */
@Composable
private fun LoginWaves() {
    Canvas(Modifier.fillMaxSize()) {
        val w = size.width
        val h = size.height
        // Top-left
        val top = Path().apply {
            moveTo(0f, 0f)
            lineTo(w * 0.62f, 0f)
            cubicTo(w * 0.40f, h * 0.02f, w * 0.22f, h * 0.10f, 0f, h * 0.13f)
            close()
        }
        drawPath(top, Brush.linearGradient(listOf(WaaproNavy, WaaproBlue), Offset(0f, 0f), Offset(w * 0.6f, h * 0.12f)))
        val topGold = Path().apply {
            moveTo(w * 0.62f, 0f)
            cubicTo(w * 0.40f, h * 0.02f, w * 0.22f, h * 0.10f, 0f, h * 0.13f)
        }
        drawPath(topGold, WaaproGold, style = Stroke(width = 5.dp.toPx()))
        // Bottom
        val bottom = Path().apply {
            moveTo(0f, h)
            lineTo(0f, h * 0.93f)
            cubicTo(w * 0.35f, h * 0.99f, w * 0.65f, h * 0.84f, w, h * 0.86f)
            lineTo(w, h)
            close()
        }
        drawPath(bottom, Brush.linearGradient(listOf(WaaproBlue, WaaproNavy), Offset(0f, h * 0.86f), Offset(w, h)))
        val bottomGold = Path().apply {
            moveTo(0f, h * 0.93f)
            cubicTo(w * 0.35f, h * 0.99f, w * 0.65f, h * 0.84f, w, h * 0.86f)
        }
        drawPath(bottomGold, WaaproGold, style = Stroke(width = 5.dp.toPx()))
    }
}
