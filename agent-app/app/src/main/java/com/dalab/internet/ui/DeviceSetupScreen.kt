package com.dalab.internet.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.data.AgentDevice
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.launch

/**
 * First-run (and re-selectable from More > Device) picker for "which
 * registered `agent_devices` row is this physical phone." Everything that
 * needs to scope a call to this device — SIM routing, health heartbeats —
 * reads DeviceIdentity afterward, so a wrong pick here means dialing on the
 * wrong SIM later; there's no "skip" option.
 */
@Composable
fun DeviceSetupScreen(onDeviceSelected: () -> Unit) {
    var devices by remember { mutableStateOf<List<AgentDevice>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun load() {
        loading = true
        error = null
        scope.launch {
            try {
                val response = ApiClient.service.getDevices()
                if (response.isSuccessful) {
                    devices = response.body().orEmpty()
                } else {
                    error = "Couldn't load devices (HTTP ${response.code()})"
                }
            } catch (e: Exception) {
                error = e.message ?: "Couldn't load devices"
            }
            loading = false
        }
    }

    LaunchedEffect(Unit) { load() }

    Column(modifier = Modifier.fillMaxSize().padding(20.dp)) {
        Text("Which device is this?", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text(
            "Pick the device registered by your Super Admin for this physical phone. " +
                "This controls which SIM routing and payment monitoring settings this phone uses.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(20.dp))

        when {
            loading -> Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            error != null -> Column(Modifier.fillMaxWidth().weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(error!!, color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(12.dp))
                Button(onClick = { load() }) { Text("Retry") }
            }
            devices.isEmpty() -> Text(
                "No devices are registered yet. Ask your Super Admin to add this device " +
                    "in the Device & USSD Configuration section of the dashboard.",
                modifier = Modifier.weight(1f),
            )
            else -> LazyColumn(modifier = Modifier.weight(1f)) {
                items(devices, key = { it.id }) { device ->
                    ListItem(
                        headlineContent = { Text(device.name) },
                        supportingContent = device.description?.takeIf { it.isNotBlank() }?.let { { Text(it) } },
                        modifier = Modifier.clickable {
                            DeviceIdentity.set(device.id, device.name, device.paymentRole)
                            onDeviceSelected()
                        },
                    )
                    Divider()
                }
            }
        }
    }
}
