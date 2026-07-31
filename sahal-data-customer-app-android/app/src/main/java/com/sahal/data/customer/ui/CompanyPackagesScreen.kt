package com.sahal.data.customer.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.SimCard
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.sahal.data.customer.data.Company
import com.sahal.data.customer.data.PackageItem
import com.sahal.data.customer.data.companyLogoRes
import com.sahal.data.customer.network.ApiClient
import com.sahal.data.customer.network.RealtimeClient
import kotlinx.coroutines.launch

/**
 * Packages within one category of a provider — reached from
 * CompanyCategoriesScreen. `initialPackages` is that screen's already-fetched
 * snapshot (instant first paint, no loading flash); this screen then keeps
 * itself live via the same catalog.updated SSE event the other catalog
 * screens listen for, so a package enabled/disabled while a customer is
 * parked exactly here still updates without them backing out and back in.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompanyPackagesScreen(
    company: Company,
    categoryId: String,
    categoryLabel: String,
    initialPackages: List<PackageItem>,
    onBack: () -> Unit,
    onBuy: (PackageItem) -> Unit,
) {
    var packages by remember(company.id, categoryId) { mutableStateOf(initialPackages) }
    val offline = company.status == "offline"
    val brandColor = remember(company.colorHex) {
        try {
            Color(android.graphics.Color.parseColor(company.colorHex))
        } catch (_: Exception) {
            Color(0xFF1D2E8C)
        }
    }
    val scope = rememberCoroutineScope()

    val realtime = remember(company.id, categoryId) {
        RealtimeClient(path = "orders/stream") {
            scope.launch {
                try {
                    packages = ApiClient.service.getPackages(company.id).body().orEmpty().filter { it.categoryId == categoryId }
                } catch (_: Exception) {
                    // Keep showing the last known list rather than clearing it on a transient error.
                }
            }
        }
    }
    DisposableEffect(realtime) {
        realtime.connect()
        onDispose { realtime.disconnect() }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(categoryLabel) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (offline) {
                Text(
                    "${company.name} is currently offline — try another provider.",
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(16.dp),
                )
            }
            if (packages.isEmpty()) {
                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    Text(
                        "No packages found for this category.",
                        modifier = Modifier.align(Alignment.Center),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            } else {
                val logoRes = remember(company.id) { companyLogoRes(company.id) }
                LazyColumn(modifier = Modifier.weight(1f).padding(vertical = 4.dp)) {
                    items(packages, key = { it.id }) { pkg ->
                        PackageCard(pkg = pkg, brandColor = brandColor, logoRes = logoRes, enabled = !offline, onBuy = { onBuy(pkg) })
                    }
                }
            }
        }
    }
}

@Composable
private fun PackageCard(pkg: PackageItem, brandColor: Color, logoRes: Int?, enabled: Boolean, onBuy: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .clickable(enabled = enabled, onClick = onBuy),
        shape = RoundedCornerShape(16.dp),
    ) {
        Row(modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            Box(
                modifier = Modifier
                    .width(92.dp)
                    .fillMaxHeight()
                    .background(if (enabled) brandColor else Color.LightGray),
                contentAlignment = Alignment.Center,
            ) {
                if (logoRes != null) {
                    Box(
                        modifier = Modifier
                            .size(52.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color.White),
                        contentAlignment = Alignment.Center,
                    ) {
                        Image(
                            painter = painterResource(id = logoRes),
                            contentDescription = null,
                            modifier = Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)),
                        )
                    }
                } else {
                    Icon(
                        Icons.Filled.SimCard,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(40.dp),
                    )
                }
            }
            Column(modifier = Modifier.weight(1f).padding(16.dp)) {
                Text(pkg.name, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (pkg.oldPrice != null && pkg.oldPrice > pkg.price) {
                        Text(
                            "$${"%.2f".format(pkg.oldPrice)}",
                            style = MaterialTheme.typography.bodyMedium,
                            textDecoration = TextDecoration.LineThrough,
                            color = MaterialTheme.colorScheme.error,
                        )
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        "$${"%.2f".format(pkg.price)}",
                        fontWeight = FontWeight.Bold,
                        color = Color(0xFF16A34A),
                    )
                }
                val details = buildList {
                    if (pkg.mb > 0) add(Icons.Filled.Wifi to "${pkg.mb} MB")
                    if (pkg.minutes > 0) add(Icons.Filled.Call to "${pkg.minutes} min")
                    if (pkg.sms > 0) add(Icons.Filled.Sms to "${pkg.sms} SMS")
                    pkg.validity?.takeIf { it.isNotBlank() }?.let { add(Icons.Filled.Schedule to it) }
                }
                if (details.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    details.forEach { (icon, label) ->
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 1.dp)) {
                            Icon(icon, contentDescription = null, tint = Color(0xFF16A34A), modifier = Modifier.size(15.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(label, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
    }
}
