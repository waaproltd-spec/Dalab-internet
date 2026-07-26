package com.dalab.internet.customer.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.network.ApiClient

/** Packages for a single provider, reached by tapping its card on Home. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompanyPackagesScreen(company: Company, onBack: () -> Unit, onBuy: (PackageItem) -> Unit) {
    var packages by remember { mutableStateOf<List<PackageItem>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    val offline = company.status == "offline"

    LaunchedEffect(company.id) {
        try {
            packages = ApiClient.service.getPackages(company.id).body().orEmpty()
        } catch (_: Exception) {
            packages = emptyList()
        }
        loading = false
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(company.name) },
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
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                if (loading) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                } else if (packages.isEmpty()) {
                    Text(
                        "No packages found for this provider.",
                        modifier = Modifier.align(Alignment.Center),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                } else {
                    LazyColumn {
                        items(packages, key = { it.id }) { pkg ->
                            PackageCard(pkg = pkg, enabled = !offline, onBuy = { onBuy(pkg) })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PackageCard(pkg: PackageItem, enabled: Boolean, onBuy: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(pkg.name, fontWeight = FontWeight.Bold)
                val details = buildList {
                    if (pkg.mb > 0) add("${pkg.mb} MB")
                    if (pkg.minutes > 0) add("${pkg.minutes} min")
                    if (pkg.sms > 0) add("${pkg.sms} SMS")
                    pkg.validity?.takeIf { it.isNotBlank() }?.let { add(it) }
                }
                if (details.isNotEmpty()) {
                    Text(details.joinToString(" · "), style = MaterialTheme.typography.bodySmall)
                }
                Spacer(Modifier.height(4.dp))
                Text("$${"%.2f".format(pkg.price)}", fontWeight = FontWeight.Bold)
            }
            Button(onClick = onBuy, enabled = enabled) { Text("Buy") }
        }
    }
}
