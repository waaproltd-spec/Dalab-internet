package com.dalab.internet.customer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AllInclusive
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Router
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.data.ServiceCategory
import com.dalab.internet.customer.network.ApiClient

/** One entry per distinct categoryId among a company's packages. */
private data class PackageCategory(val id: String, val label: String, val packages: List<PackageItem>)

// Fallback only — used when a package's categoryId doesn't match any known
// service_categories row (category_id is free text, not a foreign key, so
// this can legitimately happen for stale/typo'd data). Whenever a real
// category name is found, that admin-configured name is used instead.
private fun formatCategoryLabel(categoryId: String): String =
    categoryId.split("-", "_").joinToString(" ") { it.replaceFirstChar(Char::uppercase) }

private fun categoryIcon(categoryId: String): ImageVector {
    val id = categoryId.lowercase()
    return when {
        "voice" in id || "call" in id || "hadal" in id -> Icons.Filled.Call
        "adsl" in id || "5g" in id || "mifi" in id || "router" in id -> Icons.Filled.Router
        "unlimited" in id -> Icons.Filled.AllInclusive
        else -> Icons.Filled.PhoneAndroid
    }
}

/** Providers' packages grouped by category — tap a category to see its packages. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompanyCategoriesScreen(company: Company, onBack: () -> Unit, onSelectCategory: (String, String, List<PackageItem>) -> Unit) {
    var packages by remember { mutableStateOf<List<PackageItem>>(emptyList()) }
    var serviceCategories by remember { mutableStateOf<List<ServiceCategory>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    val offline = company.status == "offline"
    val brandColor = remember(company.colorHex) {
        try {
            Color(android.graphics.Color.parseColor(company.colorHex))
        } catch (_: Exception) {
            Color(0xFF1D2E8C)
        }
    }

    LaunchedEffect(company.id) {
        try {
            packages = ApiClient.service.getPackages(company.id).body().orEmpty()
        } catch (_: Exception) {
            packages = emptyList()
        }
        try {
            serviceCategories = ApiClient.service.getCategories(company.id).body().orEmpty()
        } catch (_: Exception) {
            serviceCategories = emptyList() // falls back to formatCategoryLabel below — never blocks showing packages
        }
        loading = false
    }

    val categories = remember(packages, serviceCategories) {
        val namesBySlug = serviceCategories.associate { it.slug to it.name }
        packages.groupBy { it.categoryId }
            .map { (id, pkgs) -> PackageCategory(id, namesBySlug[id] ?: formatCategoryLabel(id), pkgs) }
            .sortedBy { it.label }
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
            if (loading) {
                Box(modifier = Modifier.fillMaxSize()) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                }
            } else if (categories.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize()) {
                    Text(
                        "No packages found for this provider.",
                        modifier = Modifier.align(Alignment.Center),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(2),
                    contentPadding = PaddingValues(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(categories, key = { it.id }) { category ->
                        CategoryCard(
                            category = category,
                            brandColor = brandColor,
                            enabled = !offline,
                            onClick = { onSelectCategory(category.id, category.label, category.packages) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CategoryCard(category: PackageCategory, brandColor: Color, enabled: Boolean, onClick: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick)) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(vertical = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                modifier = Modifier
                    .size(56.dp)
                    .clip(CircleShape)
                    .background(if (enabled) brandColor else Color.LightGray),
                contentAlignment = Alignment.Center,
            ) {
                Icon(categoryIcon(category.id), contentDescription = null, tint = Color.White)
            }
            Spacer(Modifier.height(10.dp))
            Text(category.label, fontWeight = FontWeight.Bold)
            Text(
                "${category.packages.size} package${if (category.packages.size == 1) "" else "s"}",
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}
