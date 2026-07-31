package com.sahal.data.customer.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sahal.data.customer.data.Company
import com.sahal.data.customer.data.PackageItem
import com.sahal.data.customer.data.ServiceCategory
import com.sahal.data.customer.data.companyLogoRes
import com.sahal.data.customer.network.ApiClient
import com.sahal.data.customer.network.RealtimeClient
import kotlinx.coroutines.launch

/** One entry per distinct categoryId among a company's packages. */
private data class PackageCategory(val id: String, val label: String, val packages: List<PackageItem>)

// Fallback only — used when a package's categoryId doesn't match any known
// service_categories row (category_id is free text, not a foreign key, so
// this can legitimately happen for stale/typo'd data). Whenever a real
// category name is found, that admin-configured name is used instead.
private fun formatCategoryLabel(categoryId: String): String =
    categoryId.split("-", "_").joinToString(" ") { it.replaceFirstChar(Char::uppercase) }

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
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
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

    LaunchedEffect(company.id) { refresh() }

    // Same catalog.updated push HomeScreen listens for — a package enabled/
    // disabled/edited while a customer is browsing this company's categories
    // shows up without them having to navigate away and back.
    val realtime = remember(company.id) { RealtimeClient(path = "orders/stream") { scope.launch { refresh() } } }
    DisposableEffect(realtime) {
        realtime.connect()
        onDispose { realtime.disconnect() }
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
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    items(categories, key = { it.id }) { category ->
                        CategoryCard(
                            category = category,
                            company = company,
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

// Same card design for every provider — a colored header band carrying the
// company's own logo (not a category-specific icon; the reference design
// repeats the same provider logo on every card, only the title differs),
// and a light content section below with the category name. Deliberately
// provider-branded rather than category-branded, matching the reference.
@Composable
private fun CategoryCard(category: PackageCategory, company: Company, brandColor: Color, enabled: Boolean, onClick: () -> Unit) {
    val headerColor = if (enabled) brandColor else Color.LightGray
    val logoRes = remember(company.id) { companyLogoRes(company.id) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .shadow(3.dp, RoundedCornerShape(18.dp))
            .clip(RoundedCornerShape(18.dp))
            .background(MaterialTheme.colorScheme.surface)
            .clickable(enabled = enabled, onClick = onClick),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(88.dp)
                .background(headerColor),
            contentAlignment = Alignment.Center,
        ) {
            if (logoRes != null) {
                Image(
                    painter = painterResource(id = logoRes),
                    contentDescription = company.name,
                    modifier = Modifier.size(48.dp),
                )
            } else {
                Icon(Icons.Filled.Wifi, contentDescription = company.name, tint = Color.White, modifier = Modifier.size(36.dp))
            }
        }
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 18.dp)) {
            Text(
                category.label,
                fontWeight = FontWeight.Bold,
                fontSize = 19.sp,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "${category.packages.size} package${if (category.packages.size == 1) "" else "s"}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
