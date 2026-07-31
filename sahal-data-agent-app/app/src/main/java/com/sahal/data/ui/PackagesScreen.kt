package com.sahal.data.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sahal.data.data.Company
import com.sahal.data.data.PackageItem
import com.sahal.data.network.ApiClient
import kotlinx.coroutines.launch

/** Read-only catalog browser — lets an agent check pricing/validity before starting a sale. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PackagesScreen(onBack: () -> Unit) {
    var companies by remember { mutableStateOf<List<Company>>(emptyList()) }
    var selectedCompany by remember { mutableStateOf<Company?>(null) }
    var packages by remember { mutableStateOf<List<PackageItem>>(emptyList()) }
    var loadingCompanies by remember { mutableStateOf(true) }
    var loadingPackages by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        try {
            companies = ApiClient.service.getCompanies().body().orEmpty()
            selectedCompany = companies.firstOrNull()
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

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Packages") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        }
    ) { padding ->
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
                            PackageRow(pkg)
                            Divider()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PackageRow(pkg: PackageItem) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
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
        }
        Text("$${"%.2f".format(pkg.price)}", fontWeight = FontWeight.Bold)
    }
}
