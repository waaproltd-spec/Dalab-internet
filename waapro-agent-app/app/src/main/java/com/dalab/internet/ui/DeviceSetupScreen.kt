package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
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
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.data.AgentDevice
import com.dalab.internet.data.DeviceSimInfo
import com.dalab.internet.network.ApiClient
import kotlinx.coroutines.launch

/**
 * First-run (and re-selectable from More > Device) picker for "which
 * registered `agent_devices` row is this physical phone." Everything that
 * needs to scope a call to this device — SIM routing, health heartbeats —
 * reads DeviceIdentity afterward, so a wrong pick here means dialing on the
 * wrong SIM later; there's no "skip" option. Selecting a card only updates
 * local UI state -- DeviceIdentity itself (and onDeviceSelected) only fire
 * once Continue is tapped, so a stray tap can't silently commit the wrong
 * device. WAAPRO LTD AGENT design, the same for every system.
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
                val response = ApiClient.publicService.getDevices()
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

    Box(Modifier.fillMaxSize().background(WaaproBg)) {
        WaaproWaves()
        Column(Modifier.fillMaxSize().systemBarsPadding()) {
            LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 20.dp, bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                item {
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        WaaproLogoBlock(logoSize = 64.dp, nameSize = 24.sp)
                        Spacer(Modifier.height(8.dp))
                        WaaproAgentPill(textSize = 18.sp)
                        Spacer(Modifier.height(8.dp))
                        WaaproTagline()
                    }
                }
                item {
                    Row(verticalAlignment = Alignment.Top, modifier = Modifier.fillMaxWidth().padding(top = 4.dp)) {
                        Box(
                            modifier = Modifier.size(56.dp).clip(RoundedCornerShape(16.dp)).background(WaaproSoft),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.Filled.PhoneAndroid, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(30.dp))
                        }
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text("Which device is this?", color = WaaproNavy, fontSize = 24.sp, fontWeight = FontWeight.Black)
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "Pick the device registered by your Super Admin for this physical phone. This controls which SIM routing and payment monitoring settings this phone uses.",
                                color = WaaproMuted,
                                fontSize = 14.sp,
                                lineHeight = 19.sp,
                            )
                        }
                    }
                }
                when {
                    loading -> item {
                        Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = WaaproBlue)
                        }
                    }
                    error != null -> item {
                        Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(error!!, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
                            Spacer(Modifier.height(12.dp))
                            Button(onClick = { load() }, colors = ButtonDefaults.buttonColors(containerColor = WaaproNavy), shape = RoundedCornerShape(50)) {
                                Text("Retry", color = Color.White)
                            }
                        }
                    }
                    devices.isEmpty() -> item {
                        Text(
                            "No devices are registered yet. Ask your Super Admin to add this device in the Device & USSD Configuration section of the dashboard.",
                            modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
                            color = WaaproInk,
                            textAlign = TextAlign.Center,
                        )
                    }
                    else -> items(devices, key = { it.id }) { device ->
                        DeviceCard(device = device, selected = selectedId == device.id, onClick = { selectedId = device.id })
                    }
                }
                if (error == null && !loading) item {
                    Row(
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(WaaproSoft).padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.Info, contentDescription = null, tint = WaaproBlue, modifier = Modifier.size(26.dp))
                        Spacer(Modifier.width(12.dp))
                        Text(
                            "Choose the correct device to ensure orders, SIM routing and payment monitoring work properly.",
                            color = WaaproNavy,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }

            // Continue: disabled until a device is picked.
            val enabled = selectedId != null && devices.any { it.id == selectedId }
            Button(
                onClick = {
                    val device = devices.find { it.id == selectedId } ?: return@Button
                    DeviceIdentity.set(device.id, device.name)
                    onDeviceSelected()
                },
                enabled = enabled,
                shape = RoundedCornerShape(50),
                contentPadding = PaddingValues(0.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent, disabledContainerColor = Color.Transparent),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp).height(58.dp),
            ) {
                Box(
                    Modifier.fillMaxSize().background(
                        if (enabled) Brush.horizontalGradient(listOf(WaaproNavy, WaaproBlue))
                        else Brush.horizontalGradient(listOf(Color(0xFFB7C3D9), Color(0xFF9AA8C2))),
                    ),
                    contentAlignment = Alignment.Center,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Continue", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.width(10.dp))
                        Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null, tint = Color.White)
                    }
                }
            }
        }
    }
}

private val SelectedGreen = Color(0xFF16A34A)

@Composable
private fun DeviceCard(device: AgentDevice, selected: Boolean, onClick: () -> Unit) {
    Surface(
        color = Color.White,
        shape = RoundedCornerShape(20.dp),
        shadowElevation = if (selected) 3.dp else 1.dp,
        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) WaaproBlue else WaaproBorder),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier.size(52.dp).clip(RoundedCornerShape(14.dp)).background(WaaproSoft),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.PhoneAndroid, contentDescription = null, tint = WaaproNavy, modifier = Modifier.size(28.dp))
                }
                Spacer(Modifier.width(12.dp))
                Box(Modifier.width(1.dp).height(44.dp).background(WaaproBorder))
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(device.name, color = WaaproNavy, fontSize = 20.sp, fontWeight = FontWeight.Black, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    device.description?.takeIf { it.isNotBlank() }?.let {
                        Text(it, color = WaaproMuted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    SimSummaryLine("SIM 1", device.sim1)
                    SimSummaryLine("SIM 2", device.sim2)
                }
                Column(horizontalAlignment = Alignment.End) {
                    if (selected) {
                        Row(
                            modifier = Modifier.clip(RoundedCornerShape(50)).background(SelectedGreen).padding(horizontal = 10.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("Selected", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(Modifier.height(8.dp))
                    }
                    RadioButton(
                        selected = selected,
                        onClick = onClick,
                        colors = RadioButtonDefaults.colors(selectedColor = WaaproBlue, unselectedColor = Color(0xFF8A94A6)),
                    )
                }
            }
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                SimSection("SIM 1", device.sim1, Modifier.weight(1f))
                SimSection("SIM 2", device.sim2, Modifier.weight(1f))
            }
        }
    }
}

/** "SIM 1: Hormuud (+252610338686)" under the device name. */
@Composable
private fun SimSummaryLine(label: String, sim: DeviceSimInfo?) {
    val text = if (sim == null) "$label: —" else {
        val local = sim.phoneNumber?.let { localPhoneInput(it) }?.takeIf { it.length == 9 }
        "$label: ${sim.companyName}" + (local?.let { " (+252$it)" } ?: "")
    }
    Text(text, color = WaaproInk, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** One SIM's own section: label, network logo, network name and the SIM's number. */
@Composable
private fun SimSection(label: String, sim: DeviceSimInfo?, modifier: Modifier = Modifier) {
    Column(modifier.clip(RoundedCornerShape(14.dp)).background(Color(0xFFF0F5FD)).padding(10.dp)) {
        Text(
            label,
            color = WaaproNavy,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.clip(RoundedCornerShape(50)).background(Color(0xFFD6E6FB)).padding(horizontal = 10.dp, vertical = 3.dp),
        )
        Spacer(Modifier.height(8.dp))
        if (sim == null) {
            Text("Not routed", color = WaaproMuted, fontSize = 13.sp)
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val logo = networkLogoFor(sim)
                if (logo != null) {
                    Image(
                        painter = painterResource(logo),
                        contentDescription = sim.companyName,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.size(38.dp).clip(RoundedCornerShape(8.dp)).background(Color.White),
                    )
                } else {
                    Box(Modifier.size(38.dp).clip(RoundedCornerShape(8.dp)).background(WaaproNavy), contentAlignment = Alignment.Center) {
                        Text(sim.companyName.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold)
                    }
                }
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(sim.companyName, color = WaaproNavy, fontSize = 15.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    sim.phoneNumber?.let {
                        val local = localPhoneInput(it)
                        Text(if (local.length == 9) local else it, color = WaaproInk, fontSize = 13.sp, maxLines = 1)
                    }
                }
            }
        }
    }
}

/** The network's real logo, found by the company's key or, failing that, its name. */
private fun networkLogoFor(sim: DeviceSimInfo): Int? {
    val keys = listOf(sim.companyId.lowercase(), sim.companyName.lowercase())
    for (k in keys) {
        when {
            "hormuud" in k -> return com.dalab.internet.R.drawable.logo_hormuud
            "somtel" in k -> return com.dalab.internet.R.drawable.logo_somtel
            "somnet" in k -> return com.dalab.internet.R.drawable.logo_somnet
            "amtel" in k -> return com.dalab.internet.R.drawable.logo_amtel
        }
    }
    return null
}
