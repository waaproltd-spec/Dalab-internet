package com.dalab.internet.customer.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.dalab.internet.customer.auth.AuthRepository
import com.dalab.internet.customer.auth.OtpRequestResult
import com.dalab.internet.customer.auth.OtpVerifyResult
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.UpdateProfileRequest
import kotlinx.coroutines.launch

private enum class OtpStep { PHONE, CODE, NAME }

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
    var name by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier.fillMaxSize().padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("DALAB INTERNET", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text(
            when (step) {
                OtpStep.PHONE -> "Enter your phone number to continue"
                OtpStep.CODE -> "Enter the code we texted you"
                OtpStep.NAME -> "What should we call you?"
            },
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(28.dp))

        when (step) {
            OtpStep.PHONE -> {
                OutlinedTextField(
                    value = phone,
                    onValueChange = { phone = it },
                    label = { Text("Phone number") },
                    singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Phone),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            OtpStep.CODE -> {
                Text("Code sent to $phone", style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it },
                    label = { Text("Verification code") },
                    singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            OtpStep.NAME -> {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Your name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        Spacer(Modifier.height(20.dp))
        if (error != null) {
            Text(error!!, color = MaterialTheme.colorScheme.error)
            Spacer(Modifier.height(12.dp))
        }

        Button(
            onClick = {
                error = null
                loading = true
                scope.launch {
                    when (step) {
                        OtpStep.PHONE -> {
                            when (val result = AuthRepository.requestOtp(phone.trim())) {
                                is OtpRequestResult.Sent -> step = OtpStep.CODE
                                is OtpRequestResult.Failure -> error = result.message
                            }
                        }
                        OtpStep.CODE -> {
                            when (val result = AuthRepository.verifyOtp(phone.trim(), code.trim())) {
                                is OtpVerifyResult.Success -> {
                                    if (result.name.isNullOrBlank()) step = OtpStep.NAME else onLoggedIn()
                                }
                                is OtpVerifyResult.Failure -> error = result.message
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
            enabled = !loading && when (step) {
                OtpStep.PHONE -> phone.isNotBlank()
                OtpStep.CODE -> code.isNotBlank()
                OtpStep.NAME -> name.isNotBlank()
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                if (loading) "Please wait..."
                else when (step) {
                    OtpStep.PHONE -> "Send code"
                    OtpStep.CODE -> "Verify"
                    OtpStep.NAME -> "Continue"
                }
            )
        }

        if (step == OtpStep.CODE) {
            Spacer(Modifier.height(12.dp))
            TextButton(onClick = { step = OtpStep.PHONE; code = "" }) {
                Text("Use a different number")
            }
        }
    }
}
