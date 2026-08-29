package com.dalab.internet.customer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.RealtimeClient
import com.dalab.internet.customer.prefs.LocalizationManager
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
                LazyColumn(modifier = Modifier.weight(1f).padding(vertical = 4.dp)) {
                    items(packages, key = { it.id }) { pkg ->
                        PackageCard(pkg = pkg, brandColor = brandColor, enabled = !offline, onBuy = { onBuy(pkg) })
                    }
                }
            }
        }
    }
}

@Composable
private fun PackageCard(pkg: PackageItem, brandColor: Color, enabled: Boolean, onBuy: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
        shape = RoundedCornerShape(16.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                if (pkg.oldPrice != null && pkg.oldPrice > pkg.price) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .clip(RoundedCornerShape(50))
                            .background((if (enabled) brandColor else Color.LightGray).copy(alpha = 0.12f))
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                    ) {
                        Text(
                            "$${"%.2f".format(pkg.oldPrice)}",
                            style = MaterialTheme.typography.labelMedium,
                            textDecoration = TextDecoration.LineThrough,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            "$${"%.2f".format(pkg.price)}",
                            fontWeight = FontWeight.Bold,
                            color = Color(0xFF16A34A),
                        )
                    }
                } else {
                    Text(
                        "$${"%.2f".format(pkg.price)}",
                        fontWeight = FontWeight.Bold,
                        color = Color(0xFF16A34A),
                    )
                }
                Spacer(Modifier.height(8.dp))
                Text(pkg.name, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyLarge)
                val subtitle = buildList {
                    if (pkg.mb > 0) add("${pkg.mb} MB")
                    if (pkg.minutes > 0) add("${pkg.minutes} min")
                    if (pkg.sms > 0) add("${pkg.sms} SMS")
                    pkg.validity?.takeIf { it.isNotBlank() }?.let { add(it) }
                }.joinToString(" · ")
                if (subtitle.isNotEmpty()) {
                    Spacer(Modifier.height(2.dp))
                    Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.width(12.dp))
            Button(
                onClick = onBuy,
                enabled = enabled,
                shape = RoundedCornerShape(50),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF16A34A)),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 10.dp),
            ) {
                Text(
                    LocalizationManager.tr("BUY NOW", "IIBSO"),
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}
