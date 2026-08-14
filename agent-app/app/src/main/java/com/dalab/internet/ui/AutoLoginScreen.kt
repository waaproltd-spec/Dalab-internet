package com.dalab.internet.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.dalab.internet.auth.AuthRepository
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.auth.LoginResult
import com.dalab.internet.ui.components.DalabLogo

/**
 * There is no login screen — the app authenticates itself silently using
 * whichever agent the Super Admin has assigned to this device. This screen
 * only ever appears briefly while that call is in flight (typically well
 * under a second on a warm backend), or as an error state if this device
 * has no active agent assigned yet.
 */
@Composable
fun AutoLoginScreen(onSuccess: () -> Unit, onChooseDifferentDevice: () -> Unit) {
    var error by remember { mutableStateOf<String?>(null) }
    var errorCode by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    // Only ever sent when an admin has actually set an activation code for
    // this device (see agent_devices.activation_code_hash) -- most devices
    // have none, and the very first attempt below always tries with no code
    // at all, exactly like before this existed. This field only appears
    // once the server itself says one is needed (INVALID_ACTIVATION_CODE).
    var activationCode by remember { mutableStateOf("") }

    LaunchedEffect(attempt) {
        error = null
        errorCode = null
        val deviceId = DeviceIdentity.deviceId()
        if (deviceId == null) {
            error = "No device selected."
            return@LaunchedEffect
        }
        when (val result = AuthRepository.loginWithDevice(deviceId, activationCode.trim().ifBlank { null })) {
            is LoginResult.Success -> onSuccess()
            is LoginResult.Failure -> {
                error = result.message
                errorCode = result.code
            }
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        DalabLogo(size = 72.dp)
        Spacer(Modifier.height(16.dp))
        Text("DALAB Agent", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(28.dp))

        if (error == null) {
            CircularProgressIndicator()
            Spacer(Modifier.height(16.dp))
            Text("Connecting...", style = MaterialTheme.typography.bodyMedium)
        } else {
            Text(error!!, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
            Spacer(Modifier.height(16.dp))
            if (errorCode == "INVALID_ACTIVATION_CODE") {
                OutlinedTextField(
                    value = activationCode,
                    onValueChange = { activationCode = it },
                    label = { Text("Activation code") },
                    singleLine = true,
                )
                Spacer(Modifier.height(12.dp))
                Button(onClick = { attempt++ }, enabled = activationCode.isNotBlank()) { Text("Activate") }
            } else {
                Button(onClick = { attempt++ }) { Text("Retry") }
            }
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onChooseDifferentDevice) { Text("Choose a different device") }
        }
    }
}
