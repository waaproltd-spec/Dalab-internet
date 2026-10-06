package com.dalab.internet.ui

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.DataUsage
import androidx.compose.material.icons.filled.Router
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dalab.internet.data.Company
import com.dalab.internet.data.PackageItem
import com.dalab.internet.network.ApiClient
import com.dalab.internet.ui.theme.DalabBlue
import com.dalab.internet.ui.theme.DalabDangerRed
import com.dalab.internet.ui.theme.DalabInfoBlue
import com.dalab.internet.ui.theme.DalabOutline
import com.dalab.internet.ui.theme.DalabSoftBlue
import com.dalab.internet.ui.theme.DalabSuccessGreen
import com.dalab.internet.ui.theme.DalabSurfaceTint
import com.dalab.internet.ui.theme.DalabWhite
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.URL
import java.util.Locale

private val PkMuted = DalabBlue.copy(alpha = 0.6f)
private val PkBorder = DalabOutline.copy(alpha = 0.55f)

private fun pkUsd(v: Double) = "$" + String.format(Locale.US, "%.2f", v)

/** "30 maalin" / "30 days" -> "30 Days", "1 maalin" -> "1 Day" (also weeks,
 * months, hours); any other wording is shown as the admin typed it. */
private fun validityLabel(raw: String?): String? {
    val v = raw?.trim().orEmpty()
    if (v.isEmpty()) return null
    val m = Regex("""^(\d+)\s*([A-Za-z]+)$""").find(v) ?: return v
    val n = m.groupValues[1].toInt()
    val unit = when (m.groupValues[2].lowercase(Locale.US)) {
        "maalin", "maalmood", "day", "days" -> "Day"
        "toddobaad", "toddobaadyo", "week", "weeks" -> "Week"
        "bil", "bilood", "month", "months" -> "Month"
        "saac", "saacad", "saacadood", "hour", "hours" -> "Hour"
        else -> return v
    }
    return "$n $unit" + if (n == 1) "" else "s"
}

/** The package's service category (e.g. "Internet guri oo degdeg ah"), or
 * its allowances when it has no category name. */
private fun packageDescription(pkg: PackageItem): String? =
    pkg.categoryName?.takeIf { it.isNotBlank() } ?: buildList {
        if (pkg.mb > 0) add("${pkg.mb} MB")
        if (pkg.minutes > 0) add("${pkg.minutes} min")
        if (pkg.sms > 0) add("${pkg.sms} SMS")
    }.takeIf { it.isNotEmpty() }?.joinToString(" · ")

/** Package pictures, kept for the session so scrolling doesn't refetch them. */
private object PackageImages {
    private val cache = mutableMapOf<String, ImageBitmap?>()

    fun cached(id: String): ImageBitmap? = cache[id]

    suspend fun load(id: String): ImageBitmap? {
        if (cache.containsKey(id)) return cache[id]
        val bitmap = withContext(Dispatchers.IO) {
            try {
                val bytes = URL("${ApiClient.BASE_URL}packages/$id/image").openStream().use { it.readBytes() }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
            } catch (_: Exception) {
                null
            }
        }
        cache[id] = bitmap
        return bitmap
    }
}

/** Read-only catalog browser -- lets an agent check pricing/validity before
 * starting a sale. Companies and packages come from GET /companies and
 * GET /companies/{id}/packages; tapping a package opens its details. */
@Composable
fun PackagesScreen(onBack: () -> Unit) {
    var companies by remember { mutableStateOf<List<Company>>(emptyList()) }
    var selectedCompany by remember { mutableStateOf<Company?>(null) }
    var packages by remember { mutableStateOf<List<PackageItem>>(emptyList()) }
    var loadingCompanies by remember { mutableStateOf(true) }
    var loadingPackages by remember { mutableStateOf(false) }
    var opened by remember { mutableStateOf<PackageItem?>(null) }

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
        packages = try {
            ApiClient.service.getPackages(company.id).body().orEmpty()
        } catch (_: Exception) {
            emptyList()
        }
        loadingPackages = false
    }

    val pkg = opened
    if (pkg != null) {
        BackHandler { opened = null }
        PackageDetailsScreen(pkg, selectedCompany, onBack = { opened = null })
        return
    }

    Column(Modifier.fillMaxSize().background(DalabWhite)) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(Brush.verticalGradient(listOf(DalabSoftBlue.copy(alpha = 0.45f), DalabSurfaceTint)))
                .statusBarsPadding()
                .padding(bottom = 12.dp),
        ) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                PkRoundButton(Icons.Filled.ArrowBack, "Back", onBack)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("Packages", color = DalabBlue, fontSize = 28.sp, fontWeight = FontWeight.Black)
                    Text("Choose your internet package", color = PkMuted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                RouterVisual()
            }
            when {
                loadingCompanies -> LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 14.dp), color = DalabSuccessGreen)
                companies.isEmpty() -> Text("No providers available.", color = PkMuted, modifier = Modifier.padding(horizontal = 16.dp))
                else -> LazyRow(contentPadding = PaddingValues(horizontal = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(companies, key = { it.id }) { company ->
                        ProviderTab(company, selected = company.id == selectedCompany?.id) { selectedCompany = company }
                    }
                }
            }
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                loadingPackages -> CircularProgressIndicator(Modifier.align(Alignment.Center), color = DalabSuccessGreen)
                !loadingCompanies && packages.isEmpty() -> Text(
                    "No packages found for this provider.",
                    color = PkMuted,
                    modifier = Modifier.align(Alignment.Center),
                )
                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 12.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(packages, key = { it.id }) { p -> PackageCard(p, onClick = { opened = p }) }
                }
            }
        }
    }
}

@Composable
private fun RouterVisual() {
    Box(
        Modifier
            .size(64.dp)
            .shadow(4.dp, RoundedCornerShape(20.dp))
            .clip(RoundedCornerShape(20.dp))
            .background(Brush.linearGradient(listOf(DalabWhite, DalabSurfaceTint))),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Filled.Router, contentDescription = null, tint = DalabBlue.copy(alpha = 0.75f), modifier = Modifier.size(34.dp).offset(y = 8.dp))
        Icon(Icons.Filled.Wifi, contentDescription = null, tint = DalabSuccessGreen, modifier = Modifier.size(26.dp).offset(y = (-12).dp))
    }
}

@Composable
private fun PkRoundButton(icon: ImageVector, description: String, onClick: () -> Unit) {
    Box(
        Modifier.size(48.dp).shadow(3.dp, CircleShape).clip(CircleShape).background(DalabWhite).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = description, tint = DalabBlue)
    }
}

@Composable
private fun ProviderTab(company: Company, selected: Boolean, onClick: () -> Unit) {
    Surface(
        color = if (selected) DalabSuccessGreen else DalabWhite,
        shape = RoundedCornerShape(16.dp),
        border = if (selected) null else BorderStroke(1.dp, PkBorder),
        shadowElevation = if (selected) 3.dp else 1.dp,
        modifier = Modifier.clip(RoundedCornerShape(16.dp)).clickable(onClick = onClick),
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
            Image(
                painter = painterResource(logoResFor(company.id)),
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.size(26.dp).clip(CircleShape).background(DalabWhite).padding(2.dp),
            )
            Spacer(Modifier.width(8.dp))
            Column {
                Text(company.name, color = if (selected) DalabWhite else DalabBlue, fontWeight = FontWeight.Bold, fontSize = 15.sp, maxLines = 1)
                if (company.status == "offline") {
                    Text("Offline", color = if (selected) DalabWhite.copy(alpha = 0.85f) else DalabDangerRed, fontSize = 11.sp)
                }
            }
        }
    }
}

/** The package's own picture when the admin uploaded one, otherwise a
 * Wi-Fi mark on a soft tile. */
@Composable
private fun PackageArt(pkg: PackageItem, size: Dp) {
    var bitmap by remember(pkg.id) { mutableStateOf(PackageImages.cached(pkg.id)) }
    LaunchedEffect(pkg.id, pkg.hasImage) {
        if (pkg.hasImage && bitmap == null) bitmap = PackageImages.load(pkg.id)
    }
    val shape = RoundedCornerShape(size * 0.24f)
    val image = bitmap
    if (image != null) {
        Image(
            bitmap = image,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.size(size).shadow(2.dp, shape).clip(shape),
        )
    } else {
        Box(
            Modifier.size(size).clip(shape).background(Brush.linearGradient(listOf(DalabSoftBlue.copy(alpha = 0.55f), DalabSurfaceTint))),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Wifi, contentDescription = null, tint = DalabInfoBlue, modifier = Modifier.size(size * 0.5f))
        }
    }
}

@Composable
private fun ValidityBadge(text: String) {
    Row(
        Modifier.clip(RoundedCornerShape(10.dp)).background(DalabSuccessGreen.copy(alpha = 0.12f)).padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.CalendarMonth, contentDescription = null, tint = DalabSuccessGreen, modifier = Modifier.size(15.dp))
        Spacer(Modifier.width(5.dp))
        Text(text, color = DalabSuccessGreen, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun PackageCard(pkg: PackageItem, onClick: () -> Unit) {
    Surface(
        color = DalabWhite,
        shape = RoundedCornerShape(20.dp),
        border = BorderStroke(1.dp, PkBorder),
        shadowElevation = 2.dp,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).clickable(onClick = onClick),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
            PackageArt(pkg, 68.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(pkg.name, color = DalabBlue, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 4, overflow = TextOverflow.Ellipsis)
                packageDescription(pkg)?.let {
                    Spacer(Modifier.height(3.dp))
                    Text(it, color = PkMuted, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                validityLabel(pkg.validity)?.let {
                    Spacer(Modifier.height(8.dp))
                    ValidityBadge(it)
                }
            }
            Spacer(Modifier.width(8.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text(pkgPriceLabel(pkg), color = DalabSuccessGreen, fontSize = 19.sp, fontWeight = FontWeight.Black, maxLines = 1)
                Spacer(Modifier.height(10.dp))
                Box(
                    Modifier.size(36.dp).background(DalabSuccessGreen.copy(alpha = 0.12f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.ChevronRight, contentDescription = "Open details", tint = DalabSuccessGreen)
                }
            }
        }
    }
}

private fun pkgPriceLabel(pkg: PackageItem) = pkUsd(pkg.price)

/** One package in full -- read-only, from the row already loaded. */
@Composable
private fun PackageDetailsScreen(pkg: PackageItem, company: Company?, onBack: () -> Unit) {
    LazyColumn(Modifier.fillMaxSize().background(DalabWhite), contentPadding = PaddingValues(bottom = 24.dp)) {
        item {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(DalabSoftBlue.copy(alpha = 0.45f), DalabSurfaceTint)))
                    .statusBarsPadding()
                    .padding(horizontal = 14.dp, vertical = 12.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    PkRoundButton(Icons.Filled.ArrowBack, "Back", onBack)
                    Spacer(Modifier.width(12.dp))
                    Text("Package Details", color = DalabBlue, fontSize = 22.sp, fontWeight = FontWeight.Black)
                }
                Spacer(Modifier.height(16.dp))
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    PackageArt(pkg, 96.dp)
                    Spacer(Modifier.height(12.dp))
                    Text(pkg.name, color = DalabBlue, fontSize = 19.sp, fontWeight = FontWeight.Bold, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    packageDescription(pkg)?.let { Text(it, color = PkMuted, fontSize = 14.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center) }
                    Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(pkUsd(pkg.price), color = DalabSuccessGreen, fontSize = 32.sp, fontWeight = FontWeight.Black)
                        val old = pkg.oldPrice
                        if (old != null && old > pkg.price) {
                            Spacer(Modifier.width(10.dp))
                            Text(pkUsd(old), color = PkMuted, fontSize = 17.sp, textDecoration = TextDecoration.LineThrough)
                        }
                    }
                    validityLabel(pkg.validity)?.let {
                        Spacer(Modifier.height(8.dp))
                        ValidityBadge(it)
                    }
                    Spacer(Modifier.height(6.dp))
                }
            }
        }
        item {
            Column(Modifier.padding(start = 14.dp, end = 14.dp, top = 16.dp)) {
                Surface(
                    color = DalabWhite,
                    shape = RoundedCornerShape(16.dp),
                    border = BorderStroke(1.dp, PkBorder),
                    shadowElevation = 1.dp,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column {
                        val rows = listOfNotNull(
                            company?.let { Triple(Icons.Filled.Router, "Provider", it.name) },
                            pkg.categoryName?.takeIf { it.isNotBlank() }?.let { Triple(Icons.Filled.Wifi, "Category", it) },
                            validityLabel(pkg.validity)?.let { Triple(Icons.Filled.CalendarMonth, "Validity", it) },
                            pkg.mb.takeIf { it > 0 }?.let { Triple(Icons.Filled.DataUsage, "Data", "$it MB") },
                            pkg.minutes.takeIf { it > 0 }?.let { Triple(Icons.Filled.Call, "Minutes", "$it min") },
                            pkg.sms.takeIf { it > 0 }?.let { Triple(Icons.Filled.Sms, "SMS", "$it") },
                        )
                        rows.forEachIndexed { i, (icon, label, value) ->
                            if (i > 0) Divider(color = DalabSurfaceTint)
                            Row(Modifier.padding(horizontal = 14.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(icon, contentDescription = null, tint = DalabSuccessGreen, modifier = Modifier.size(20.dp))
                                Spacer(Modifier.width(10.dp))
                                Text(label, color = PkMuted, fontSize = 14.sp, modifier = Modifier.weight(1f))
                                Text(value, color = DalabBlue, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
        }
    }
}
