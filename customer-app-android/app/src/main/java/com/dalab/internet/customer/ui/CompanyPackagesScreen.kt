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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.PackageItem

/** Packages within one category of a provider — reached from CompanyCategoriesScreen. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompanyPackagesScreen(
    company: Company,
    categoryLabel: String,
    packages: List<PackageItem>,
    onBack: () -> Unit,
    onBuy: (PackageItem) -> Unit,
) {
    val offline = company.status == "offline"

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
                LazyColumn(modifier = Modifier.weight(1f)) {
                    items(packages, key = { it.id }) { pkg ->
                        PackageCard(pkg = pkg, enabled = !offline, onBuy = { onBuy(pkg) })
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
                    if (pkg.mb > 0) add("${pkg.mb} MB")
                    if (pkg.minutes > 0) add("${pkg.minutes} min")
                    if (pkg.sms > 0) add("${pkg.sms} SMS")
                    pkg.validity?.takeIf { it.isNotBlank() }?.let { add(it) }
                }
                if (details.isNotEmpty()) {
                    Spacer(Modifier.height(4.dp))
                    Text(details.joinToString(" · "), style = MaterialTheme.typography.bodySmall)
                }
            }
            Spacer(Modifier.width(12.dp))
            Button(onClick = onBuy, enabled = enabled) { Text("Buy") }
        }
    }
}
