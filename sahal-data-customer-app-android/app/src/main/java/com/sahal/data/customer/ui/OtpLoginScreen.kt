package com.sahal.data.customer.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sahal.data.customer.auth.AuthRepository
import com.sahal.data.customer.auth.OtpRequestResult
import com.sahal.data.customer.auth.OtpVerifyResult
import com.sahal.data.customer.auth.SessionManager
import com.sahal.data.customer.network.ApiClient
import com.sahal.data.customer.network.PinBody
import com.sahal.data.customer.network.UpdateProfileRequest
import kotlinx.coroutines.launch

// PIN is inserted only when the customer already created one (result.pinSet
// from OTP verify) — otherwise this step is skipped entirely and the flow is
// exactly PHONE -> CODE -> (NAME) -> logged in, unchanged from before.
private enum class OtpStep { PHONE, CODE, PIN, NAME }

// Same SAHAL DATA brand colors used elsewhere in this app (HomeScreen's banner gradient).
private val SahalDataIndigo = Color(0xFF1D2E8C)
private val SahalDataGreen = Color(0xFF16A34A)
private val ScreenBackground = Color(0xFFF6F7FC)
private val FieldBorder = Color(0xFFD8DCEF)

/**
 * Account creation and login are the same flow here, matching the backend:
 * POST /auth/otp/verify creates the customer record on first use. If the
 * customer has no name on file yet (brand new account), we prompt for one via
 * PUT /customer/profile before entering the app.
 */
@Composable
fun OtpLoginScreen(onLoggedIn: () -> Unit) {
    var step by remember { mutableStateOf(OtpStep.PHONE) }
    var phone by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var pendingName by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var otpCode by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // After a PIN (or a PIN-less OTP success) is confirmed, either the NAME
    // step or onLoggedIn() follows — same decision either path used to make
    // right after OTP verify, now shared so PIN doesn't duplicate it.
    fun proceedAfterVerified(customerName: String?) {
        if (customerName.isNullOrBlank()) step = OtpStep.NAME else onLoggedIn()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(ScreenBackground)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 28.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (step == OtpStep.PHONE) {
            CountrySelectorRow()
            Spacer(Modifier.height(24.dp))
            LoginIllustration()
            Spacer(Modifier.height(24.dp))
            Text(
                "Welcome to",
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                color = SahalDataGreen,
            )
            Spacer(Modifier.height(4.dp))
        }
        BrandHeader()
        Spacer(Modifier.height(28.dp))

        Text(
            "Internet you can trust.",
            style = TextStyle(
                brush = Brush.horizontalGradient(listOf(SahalDataIndigo, SahalDataGreen)),
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(10.dp))
        Text(
            when (step) {
                OtpStep.PHONE -> "Enter your phone number to continue"
                OtpStep.CODE -> "Enter the code we texted you"
                OtpStep.PIN -> "Enter your PIN"
                OtpStep.NAME -> "What should we call you?"
            },
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            color = Color(0xFF2B2F42),
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(28.dp))

        when (step) {
            OtpStep.PHONE -> {
                SahalDataTextField(
                    value = phone,
                    onValueChange = { phone = it },
                    label = "Phone number",
                    placeholder = "252 6X XXX XXXX",
                    keyboardType = KeyboardType.Phone,
                    leadingChip = { CountryChip() },
                )
            }
            OtpStep.CODE -> {
                Text(
                    "Code sent to $phone",
                    fontSize = 13.sp,
                    color = Color(0xFF6B7094),
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(16.dp))

                if (otpCode != null) {
                    OtpCodeCard(otpCode!!)
                    Spacer(Modifier.height(18.dp))
                }

                Text(
                    "Confirmation code",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Color(0xFF2B2F42),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OtpBoxInput(value = code, onValueChange = { code = it }, length = 4)
            }
            OtpStep.PIN -> {
                Text(
                    "You created a PIN for faster, more secure sign-in",
                    fontSize = 13.sp,
                    color = Color(0xFF6B7094),
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(16.dp))
                SahalDataTextField(
                    value = pin,
                    onValueChange = { if (it.length <= 8 && it.all(Char::isDigit)) pin = it },
                    label = "PIN",
                    placeholder = "Enter your PIN",
                    keyboardType = KeyboardType.NumberPassword,
                    masked = true,
                )
            }
            OtpStep.NAME -> {
                SahalDataTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = "Your name",
                    placeholder = "Your name",
                    keyboardType = KeyboardType.Text,
                )
            }
        }

        Spacer(Modifier.height(20.dp))
        if (error != null) {
            Text(error!!, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))
        }

        GradientButton(
            text = if (loading) "Please wait..." else when (step) {
                OtpStep.PHONE -> "Send code"
                OtpStep.CODE -> "Verify"
                OtpStep.PIN -> "Unlock"
                OtpStep.NAME -> "Continue"
            },
            enabled = !loading && when (step) {
                OtpStep.PHONE -> phone.isNotBlank()
                OtpStep.CODE -> code.isNotBlank()
                OtpStep.PIN -> pin.isNotBlank()
                OtpStep.NAME -> name.isNotBlank()
            },
            onClick = {
                error = null
                loading = true
                scope.launch {
                    when (step) {
                        OtpStep.PHONE -> {
                            when (val result = AuthRepository.requestOtp(phone.trim())) {
                                is OtpRequestResult.Sent -> {
                                    otpCode = result.otpCode
                                    step = OtpStep.CODE
                                }
                                is OtpRequestResult.Failure -> error = result.message
                            }
                        }
                        OtpStep.CODE -> {
                            when (val result = AuthRepository.verifyOtp(phone.trim(), code.trim())) {
                                is OtpVerifyResult.Success -> {
                                    if (result.pinSet) {
                                        pendingName = result.name
                                        step = OtpStep.PIN
                                    } else {
                                        proceedAfterVerified(result.name)
                                    }
                                }
                                is OtpVerifyResult.Failure -> error = result.message
                            }
                        }
                        OtpStep.PIN -> {
                            try {
                                val response = ApiClient.service.verifyPin(PinBody(pin.trim()))
                                if (response.isSuccessful && response.body()?.valid == true) {
                                    proceedAfterVerified(pendingName)
                                } else {
                                    error = "Incorrect PIN. Please try again."
                                    pin = ""
                                }
                            } catch (_: Exception) {
                                error = "Couldn't reach the server. Check your connection."
                            }
                        }
                        OtpStep.NAME -> {
                            try {
                                val response = ApiClient.service.updateProfile(UpdateProfileRequest(name.trim()))
                                response.body()?.let { SessionManager.updateProfile(it) }
                                onLoggedIn()
                            } catch (_: Exception) {
                                error = "Couldn't save your name — you can add it later from Profile."
                                onLoggedIn()
                            }
                        }
                    }
                    loading = false
                }
            },
        )

        if (step == OtpStep.CODE) {
            Spacer(Modifier.height(14.dp))
            TextButton(onClick = { step = OtpStep.PHONE; code = ""; otpCode = null }) {
                Text("Use a different number", color = SahalDataIndigo, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun BrandHeader() {
    Box(
        modifier = Modifier
            .size(64.dp)
            .clip(CircleShape)
            .background(Brush.horizontalGradient(listOf(SahalDataIndigo, SahalDataGreen))),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Filled.Wifi, contentDescription = null, tint = Color.White, modifier = Modifier.size(32.dp))
    }
    Spacer(Modifier.height(14.dp))
    Text("SAHAL DATA", fontSize = 32.sp, fontWeight = FontWeight.Black, color = SahalDataIndigo, letterSpacing = 0.5.sp)
    Text("INTERNET", fontSize = 16.sp, fontWeight = FontWeight.Bold, color = SahalDataGreen, letterSpacing = 4.sp)
}

/** Somalia-only today — a static display pill (not a real multi-country
 * picker) so the screen still reads as "your region is recognized" without
 * pretending to support a dropdown of countries this app doesn't serve. */
@Composable
private fun CountrySelectorRow() {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Surface(
            shape = RoundedCornerShape(20.dp),
            border = BorderStroke(1.dp, FieldBorder),
            color = Color.White,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            ) {
                Icon(Icons.Filled.Public, contentDescription = null, tint = SahalDataGreen, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Somalia", fontWeight = FontWeight.SemiBold, color = SahalDataGreen, fontSize = 14.sp)
                Spacer(Modifier.width(6.dp))
                Icon(Icons.Filled.ExpandMore, contentDescription = null, tint = SahalDataGreen, modifier = Modifier.size(18.dp))
            }
        }
    }
}

/** A simple, self-contained illustration built from shapes/icons (no bitmap
 * assets) evoking "a verified phone sign-in": a phone mock-up with a
 * profile avatar and a masked code row, with a checkmark and a shield
 * badge overlapping the corners. */
@Composable
private fun LoginIllustration() {
    Box(modifier = Modifier.size(180.dp), contentAlignment = Alignment.Center) {
        Box(
            modifier = Modifier
                .size(150.dp, 170.dp)
                .clip(RoundedCornerShape(24.dp))
                .background(Color.White)
                .border(2.dp, FieldBorder, RoundedCornerShape(24.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    modifier = Modifier
                        .size(56.dp)
                        .clip(CircleShape)
                        .background(Color(0xFFFBC02D)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.Person, contentDescription = null, tint = Color.White, modifier = Modifier.size(32.dp))
                }
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    repeat(5) { i ->
                        Box(
                            modifier = Modifier
                                .size(7.dp)
                                .clip(CircleShape)
                                .background(if (i < 2) SahalDataGreen else FieldBorder),
                        )
                    }
                }
            }
        }
        Box(
            modifier = Modifier
                .align(Alignment.TopStart)
                .size(36.dp)
                .clip(CircleShape)
                .background(SahalDataGreen),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
        }
        Box(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .size(40.dp)
                .clip(CircleShape)
                .background(Color.White)
                .border(2.dp, SahalDataGreen, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Shield, contentDescription = null, tint = SahalDataGreen, modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
private fun CountryChip() {
    Surface(
        color = Color(0xFFEFF1FA),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.padding(start = 4.dp, end = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Text("🇸🇴", fontSize = 15.sp)
            Spacer(Modifier.width(6.dp))
            Text("+252", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = Color(0xFF2B2F42))
        }
    }
}

@Composable
private fun SahalDataTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
    keyboardType: KeyboardType,
    leadingChip: (@Composable () -> Unit)? = null,
    masked: Boolean = false,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        placeholder = { Text(placeholder, color = Color(0xFFA6ABC9)) },
        singleLine = true,
        leadingIcon = leadingChip,
        visualTransformation = if (masked) PasswordVisualTransformation() else VisualTransformation.None,
        shape = RoundedCornerShape(14.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = SahalDataIndigo,
            unfocusedBorderColor = FieldBorder,
        ),
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun OtpCodeCard(code: String) {
    Surface(
        color = Color(0xFFEFF3FF),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Your code is", fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, color = SahalDataIndigo)
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                code.forEach { digit ->
                    Box(
                        modifier = Modifier
                            .size(42.dp)
                            .background(Color.White, RoundedCornerShape(10.dp)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(digit.toString(), fontSize = 19.sp, fontWeight = FontWeight.Bold, color = SahalDataIndigo)
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
            Text("Enter this code below", fontSize = 11.5.sp, color = Color(0xFF6B7094))
        }
    }
}

@Composable
private fun OtpBoxInput(value: String, onValueChange: (String) -> Unit, length: Int) {
    val focusRequester = remember { FocusRequester() }
    Box(modifier = Modifier.fillMaxWidth()) {
        BasicTextField(
            value = value,
            onValueChange = { if (it.length <= length && it.all(Char::isDigit)) onValueChange(it) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            textStyle = TextStyle(color = Color.Transparent),
            cursorBrush = SolidColor(Color.Transparent),
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(focusRequester),
            decorationBox = {
                Row(horizontalArrangement = Arrangement.SpaceEvenly, modifier = Modifier.fillMaxWidth()) {
                    repeat(length) { i ->
                        val char = value.getOrNull(i)?.toString() ?: ""
                        val isNext = i == value.length
                        Box(
                            modifier = Modifier
                                .size(52.dp)
                                .border(
                                    width = if (isNext) 2.dp else 1.dp,
                                    color = if (isNext) SahalDataIndigo else FieldBorder,
                                    shape = RoundedCornerShape(12.dp),
                                )
                                .background(Color.White, RoundedCornerShape(12.dp)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(char, fontSize = 22.sp, fontWeight = FontWeight.Bold, color = SahalDataIndigo)
                        }
                    }
                }
            },
        )
    }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
}

@Composable
private fun GradientButton(text: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .clip(RoundedCornerShape(28.dp))
            .background(if (enabled) SahalDataGreen else Color(0xFFBDC2E0))
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 17.sp)
    }
}
