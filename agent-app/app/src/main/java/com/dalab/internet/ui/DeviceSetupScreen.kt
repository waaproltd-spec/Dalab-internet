package com.dalab.internet.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.data.AgentDevice
import com.dalab.internet.data.DeviceSimInfo
import com.dalab.internet.network.ApiClient
import com.dalab.internet.ui.theme.DalabDangerRed
import com.dalab.internet.ui.theme.DalabSurfaceTint
import kotlinx.coroutines.launch

/**
 * First-run (and re-selectable from More > Device) picker for "which
 * registered `agent_devices` row is this physical phone." Everything that
 * needs to scope a call to this device — SIM routing, health heartbeats —
 * reads DeviceIdentity afterward, so a wrong pick here means dialing on the
 * wrong SIM later; there's no "skip" option. Selecting a card only updates
 * local UI state -- DeviceIdentity itself (and onDeviceSelected) only fire
 * once Continue is tapped, so a stray tap can't silently commit the wrong
 * device the way the old single-tap list did.
 */
@Composable
fun DeviceSetupScreen(onDeviceSelected: () -> Unit) {
    var devices by remember { mutableStateOf<List<AgentDevice>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var selectedId by remember { mutableStateOf<String?>(null) }
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

    Scaffold(containerColor = Color.White) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            Column(modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp)) {
                Box(
                    modifier = Modifier.size(56.dp).background(DalabSoftBlue.copy(alpha = 0.4f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.PhoneAndroid, contentDescription = null, tint = DalabIndigo, modifier = Modifier.size(28.dp))
                }
                Spacer(Modifier.height(14.dp))
                Text("Which device is this?", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = DalabIndigo)
                Spacer(Modifier.height(4.dp))
                Text(
                    "Pick the device registered by your Super Admin for this physical phone. This controls which SIM routing and payment monitoring settings this phone uses.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFF6B7280),
                )
            }

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                when {
                    loading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                    error != null -> Column(
                        modifier = Modifier.align(Alignment.Center).padding(horizontal = 24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(error!!, color = DalabDangerRed, style = MaterialTheme.typography.bodyMedium)
                        Spacer(Modifier.height(12.dp))
                        Button(onClick = { load() }, colors = ButtonDefaults.buttonColors(containerColor = DalabIndigo)) { Text("Retry") }
                    }
                    devices.isEmpty() -> Text(
                        "No devices are registered yet. Ask your Super Admin to add this device in the Device & USSD Configuration section of the dashboard.",
                        modifier = Modifier.align(Alignment.Center).padding(horizontal = 24.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                    else -> LazyColumn(
                        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        items(devices, key = { it.id }) { device ->
                            DeviceCard(
                                device = device,
                                selected = selectedId == device.id,
                                onClick = { selectedId = device.id },
                            )
                        }
                        item { Spacer(Modifier.height(4.dp)) }
                    }
                }
            }

            Column(modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp)) {
                if (error == null) {
                    Surface(color = DalabSoftBlue.copy(alpha = 0.2f), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                        Text(
                            "Choose the correct device to ensure orders, SIM routing and payment monitoring work properly.",
                            style = MaterialTheme.typography.bodySmall,
                            color = DalabIndigo,
                            modifier = Modifier.padding(12.dp),
                        )
                    }
                    Spacer(Modifier.height(14.dp))
                }
                Button(
                    onClick = {
                        val device = devices.find { it.id == selectedId } ?: return@Button
                        DeviceIdentity.set(device.id, device.name)
                        onDeviceSelected()
                    },
                    enabled = selectedId != null,
                    colors = ButtonDefaults.buttonColors(containerColor = DalabIndigo),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().height(50.dp),
                ) {
                    Text("Continue →", fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
private fun DeviceCard(device: AgentDevice, selected: Boolean, onClick: () -> Unit) {
    Surface(
        color = if (selected) DalabSoftBlue.copy(alpha = 0.15f) else Color.White,
        shape = RoundedCornerShape(16.dp),
        shadowElevation = if (selected) 0.dp else 1.dp,
        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) DalabIndigo else DalabSurfaceTint),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier.size(40.dp).background(DalabSoftBlue.copy(alpha = 0.35f), RoundedCornerShape(10.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.PhoneAndroid, contentDescription = null, tint = DalabIndigo, modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(device.name, fontWeight = FontWeight.Bold, color = DalabIndigo, style = MaterialTheme.typography.titleMedium)
                    device.description?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = Color(0xFF6B7280))
                    }
                    Spacer(Modifier.height(2.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(modifier = Modifier.size(6.dp).background(if (selected) DalabGreen else Color(0xFF9CA3AF), CircleShape))
                        Spacer(Modifier.width(5.dp))
                        Text(
                            if (selected) "Registered" else "Not selected",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (selected) DalabGreen else Color(0xFF6B7280),
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
                Icon(
                    if (selected) Icons.Filled.RadioButtonChecked else Icons.Filled.RadioButtonUnchecked,
                    contentDescription = if (selected) "Selected" else "Not selected",
                    tint = if (selected) DalabIndigo else Color(0xFFD1D5DB),
                    modifier = Modifier.size(24.dp),
                )
            }

            if (device.sim1 != null || device.sim2 != null) {
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    SimInfoChip(label = "SIM 1", sim = device.sim1, modifier = Modifier.weight(1f))
                    SimInfoChip(label = "SIM 2", sim = device.sim2, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun SimInfoChip(label: String, sim: DeviceSimInfo?, modifier: Modifier = Modifier) {
    Surface(color = DalabSurfaceTint, shape = RoundedCornerShape(10.dp), modifier = modifier) {
        Column(modifier = Modifier.padding(10.dp)) {
            Text(label, style = MaterialTheme.typography.labelSmall, color = Color(0xFF6B7280), fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            if (sim == null) {
                Text("Not routed", style = MaterialTheme.typography.labelSmall, color = Color(0xFF9CA3AF))
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Image(
                        painter = painterResource(logoResFor(sim.companyId)),
                        contentDescription = sim.companyName,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(5.dp))
                    Text(sim.companyName, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = DalabIndigo, maxLines = 1)
                }
                if (sim.phoneNumber != null) {
                    Text(sim.phoneNumber, style = MaterialTheme.typography.labelSmall, color = Color(0xFF6B7280))
                }
            }
        }
    }
}
