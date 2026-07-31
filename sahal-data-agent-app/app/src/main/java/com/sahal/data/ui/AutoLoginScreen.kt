package com.sahal.data.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.sahal.data.auth.AuthRepository
import com.sahal.data.auth.DeviceIdentity
import com.sahal.data.auth.LoginResult

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
    var attempt by remember { mutableStateOf(0) }

    LaunchedEffect(attempt) {
        error = null
        val deviceId = DeviceIdentity.deviceId()
        if (deviceId == null) {
            error = "No device selected."
            return@LaunchedEffect
        }
        when (val result = AuthRepository.loginWithDevice(deviceId)) {
            is LoginResult.Success -> onSuccess()
            is LoginResult.Failure -> error = result.message
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Sahal Data Agent", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(28.dp))

        if (error == null) {
            CircularProgressIndicator()
            Spacer(Modifier.height(16.dp))
            Text("Connecting...", style = MaterialTheme.typography.bodyMedium)
        } else {
            Text(error!!, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
            Spacer(Modifier.height(16.dp))
            Button(onClick = { attempt++ }) { Text("Retry") }
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onChooseDifferentDevice) { Text("Choose a different device") }
        }
    }
}
