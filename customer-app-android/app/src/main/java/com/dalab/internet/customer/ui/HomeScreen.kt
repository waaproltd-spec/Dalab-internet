package com.dalab.internet.customer.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.RateReview
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.PromoImage
import com.dalab.internet.customer.data.companyLogoRes
import com.dalab.internet.customer.network.ApiClient
import java.util.Calendar

private const val SUPPORT_PHONE = "252610338686"

private fun greeting(): String {
    val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
    return when {
        hour < 12 -> "Good Morning"
        hour < 18 -> "Good Afternoon"
        else -> "Good Evening"
    }
}

/** Home: greeting and the provider grid — tap a provider to see its packages. */
@Composable
fun HomeScreen(onOpenCompany: (Company) -> Unit) {
    var companies by remember { mutableStateOf<List<Company>>(emptyList()) }
    var promoImages by remember { mutableStateOf<List<PromoImage>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var showSupport by remember { mutableStateOf(false) }
    val customer = SessionManager.currentCustomer()
    val context = LocalContext.current

    LaunchedEffect(Unit) {
        try {
            companies = ApiClient.service.getCompanies().body().orEmpty()
        } catch (_: Exception) {
            // Leave the list empty; the grid shows "no providers" below.
        }
        loading = false
    }

    LaunchedEffect(Unit) {
        try {
            promoImages = ApiClient.service.getPromoImages().body().orEmpty().sortedBy { it.position }
        } catch (_: Exception) {
            // Carousel just doesn't show — nothing else on Home depends on it.
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        LazyVerticalGrid(
            columns = GridCells.Fixed(2),
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item(span = { GridItemSpan(2) }) {
                Column {
                    Text(greeting(), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        customer?.name?.takeIf { it.isNotBlank() } ?: customer?.phone ?: "there",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    if (promoImages.isNotEmpty()) {
                        Spacer(Modifier.height(16.dp))
                        PromoImageCarousel(images = promoImages)
                    }
                    Spacer(Modifier.height(20.dp))
                    if (loading) {
                        CircularProgressIndicator(modifier = Modifier.padding(vertical = 16.dp))
                    } else if (companies.isEmpty()) {
                        Text("No providers available.", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }

            items(companies, key = { it.id }) { company ->
                CompanyCard(company = company, onClick = { onOpenCompany(company) })
            }

            item(span = { GridItemSpan(2) }) { Spacer(Modifier.height(72.dp)) }
        }

        FloatingActionButton(
            onClick = { showSupport = true },
            modifier = Modifier.align(Alignment.BottomEnd).padding(20.dp),
        ) {
            Icon(Icons.Filled.SupportAgent, contentDescription = "Support")
        }
    }

    if (showSupport) {
        AlertDialog(
            onDismissRequest = { showSupport = false },
            title = { Text("Need help?") },
            text = {
                Column {
                    Text("Reach DALAB Internet support directly:")
                    Spacer(Modifier.height(12.dp))
                    SupportActionRow(
                        icon = Icons.Filled.Call,
                        label = "Call Us",
                        onClick = {
                            context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$SUPPORT_PHONE")))
                            showSupport = false
                        },
                    )
                    Spacer(Modifier.height(8.dp))
                    SupportActionRow(
                        icon = Icons.Filled.Chat,
                        label = "WhatsApp",
                        onClick = {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$SUPPORT_PHONE")))
                            showSupport = false
                        },
                    )
                    Spacer(Modifier.height(8.dp))
                    SupportActionRow(
                        icon = Icons.Filled.RateReview,
                        label = "Make Suggestion",
                        onClick = {
                            val text = Uri.encode("Hi DALAB, I'd like to share a suggestion: ")
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$SUPPORT_PHONE?text=$text")))
                            showSupport = false
                        },
                    )
                }
            },
            confirmButton = { TextButton(onClick = { showSupport = false }) { Text("Close") } },
        )
    }
}

@Composable
private fun SupportActionRow(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFFEFF1FA))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = Color(0xFF1D2E8C), modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(12.dp))
        Text(label, fontWeight = FontWeight.SemiBold)
    }
}

/**
 * Super Admin-uploaded promotional images (up to 5), shown as a swipeable
 * carousel — customers can only view these, never upload. Each page loads
 * its image from GET /promo-images/{id}/image via Coil (the one place this
 * app needs async remote image loading; provider logos are bundled local
 * drawables instead). Recommended upload size is 1280x658 (the dashboard's
 * upload copy states this too) — the pager uses that exact aspect ratio so
 * a correctly-sized image is never cropped/distorted.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PromoImageCarousel(images: List<PromoImage>) {
    val pagerState = rememberPagerState(pageCount = { images.size })
    Column {
        HorizontalPager(
            state = pagerState,
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(1280f / 658f),
        ) { page ->
            AsyncImage(
                model = "${ApiClient.BASE_URL}promo-images/${images[page].id}/image",
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .fillMaxSize()
                    .clip(RoundedCornerShape(20.dp)),
            )
        }
        if (images.size > 1) {
            Row(
                horizontalArrangement = Arrangement.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            ) {
                repeat(images.size) { i ->
                    val active = pagerState.currentPage == i
                    Box(
                        modifier = Modifier
                            .padding(horizontal = 3.dp)
                            .size(if (active) 8.dp else 6.dp)
                            .clip(CircleShape)
                            .background(if (active) Color(0xFF1D2E8C) else Color(0xFFD8DCEF)),
                    )
                }
            }
        }
    }
}

@Composable
private fun CompanyCard(company: Company, onClick: () -> Unit) {
    val offline = company.status == "offline"
    val brandColor = remember(company.colorHex) {
        try {
            Color(android.graphics.Color.parseColor(company.colorHex))
        } catch (_: Exception) {
            Color(0xFF1D2E8C)
        }
    }
    val logoRes = remember(company.id) { companyLogoRes(company.id) }
    val borderColor = if (offline) Color.LightGray else brandColor

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(Color.White)
            .border(width = 1.5.dp, color = borderColor, shape = RoundedCornerShape(20.dp))
            .clickable(enabled = !offline, onClick = onClick)
            .padding(vertical = 22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .size(76.dp)
                .clip(CircleShape)
                .background(borderColor.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(60.dp)
                    .clip(CircleShape)
                    .background(Color.White)
                    .border(width = 1.5.dp, color = borderColor, shape = CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                if (offline) {
                    Icon(Icons.Filled.WifiOff, contentDescription = "Offline", tint = Color.DarkGray)
                } else if (logoRes != null) {
                    Image(
                        painter = painterResource(id = logoRes),
                        contentDescription = company.name,
                        modifier = Modifier.size(60.dp).clip(CircleShape),
                    )
                } else {
                    Text(
                        company.name.take(1).uppercase(),
                        color = brandColor,
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        Text(company.name, fontWeight = FontWeight.Bold)
        if (offline) {
            Text("Offline", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        }
    }
}
