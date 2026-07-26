package com.dalab.internet.customer.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.network.ApiClient
import kotlinx.coroutines.launch

/** Browse providers and packages, then start a purchase. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(onBuy: (Company, PackageItem) -> Unit) {
    var companies by remember { mutableStateOf<List<Company>>(emptyList()) }
    var selectedCompany by remember { mutableStateOf<Company?>(null) }
    var packages by remember { mutableStateOf<List<PackageItem>>(emptyList()) }
    var loadingCompanies by remember { mutableStateOf(true) }
    var loadingPackages by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        try {
            companies = ApiClient.service.getCompanies().body().orEmpty()
            selectedCompany = companies.firstOrNull { it.status == "online" } ?: companies.firstOrNull()
        } catch (_: Exception) {
            // Leave the list empty; the screen shows "no providers" below.
        }
        loadingCompanies = false
    }

    LaunchedEffect(selectedCompany) {
        val company = selectedCompany ?: return@LaunchedEffect
        loadingPackages = true
        scope.launch {
            try {
                packages = ApiClient.service.getPackages(company.id).body().orEmpty()
            } catch (_: Exception) {
                packages = emptyList()
            }
            loadingPackages = false
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text("Buy a package") }) }) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (loadingCompanies) {
                CircularProgressIndicator(modifier = Modifier.padding(16.dp))
            } else if (companies.isEmpty()) {
                Text("No providers available.", modifier = Modifier.padding(16.dp))
            } else {
                LazyRow(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(companies, key = { it.id }) { company ->
                        FilterChip(
                            selected = company.id == selectedCompany?.id,
                            onClick = { selectedCompany = company },
                            label = { Text(if (company.status == "offline") "${company.name} (offline)" else company.name) },
                        )
                    }
                }
            }

            val offline = selectedCompany?.status == "offline"
            if (offline) {
                Text(
                    "${selectedCompany?.name} is currently offline — try another provider.",
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                if (loadingPackages) {
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
                            PackageCard(
                                pkg = pkg,
                                enabled = !offline,
                                onBuy = { selectedCompany?.let { onBuy(it, pkg) } },
                            )
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
