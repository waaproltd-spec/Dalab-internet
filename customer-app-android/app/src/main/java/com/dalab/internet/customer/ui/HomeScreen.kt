package com.dalab.internet.customer.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
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
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.RateReview
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.PromoImage
import com.dalab.internet.customer.data.companyLogoRes
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.RealtimeClient
import com.dalab.internet.customer.prefs.LocalizationManager
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Calendar

private const val SUPPORT_PHONE = "252610338686"
private val HeaderStart = Color(0xFF1D2E8C)
private val HeaderEnd = Color(0xFF16A34A)

private fun greeting(): Pair<String, String> {
    val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
    return when {
        hour < 12 -> "Good Morning" to "Subax Wanaagsan"
        hour < 18 -> "Good Afternoon" to "Galab Wanaagsan"
        else -> "Good Evening" to "Fiid Wanaagsan"
    }
}

/**
 * Home: a colourful gradient welcome header (avatar, greeting, notification
 * + settings icons) followed by the promo carousel and provider grid — tap
 * a provider to see its packages.
 */
@Composable
fun HomeScreen(onOpenCompany: (Company) -> Unit, onOpenNotifications: () -> Unit, onOpenSettings: () -> Unit) {
    var companies by remember { mutableStateOf<List<Company>>(emptyList()) }
    var promoImages by remember { mutableStateOf<List<PromoImage>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var showSupport by remember { mutableStateOf(false) }
    var contentVisible by remember { mutableStateOf(false) }
    val customer = SessionManager.currentCustomer()
    val context = LocalContext.current
    val compact = LocalConfiguration.current.screenHeightDp < 700
    val scope = rememberCoroutineScope()

    suspend fun refreshCompanies() {
        try {
            companies = ApiClient.service.getCompanies().body().orEmpty()
        } catch (_: Exception) {
            // Leave the list as-is; the grid shows "no providers" below on first load.
        }
        loading = false
        contentVisible = true
    }

    LaunchedEffect(Unit) { refreshCompanies() }

    LaunchedEffect(Unit) {
        try {
            promoImages = ApiClient.service.getPromoImages().body().orEmpty().sortedBy { it.position }
        } catch (_: Exception) {
            // Carousel just doesn't show — nothing else on Home depends on it.
        }
    }

    // A package/company saved or disabled on the dashboard reaches this
    // screen instantly instead of waiting for the customer to navigate away
    // and back — same SSE pattern OrdersScreen already uses for order status,
    // catalog.updated just added to the shared event stream.
    val realtime = remember { RealtimeClient(path = "orders/stream") { scope.launch { refreshCompanies() } } }
    DisposableEffect(realtime) {
        realtime.connect()
        onDispose { realtime.disconnect() }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            HomeHeader(
                customerLabel = customer?.name?.takeIf { it.isNotBlank() } ?: customer?.phone ?: "there",
                compact = compact,
                onOpenNotifications = onOpenNotifications,
                onOpenSettings = onOpenSettings,
            )

            AnimatedVisibility(
                visible = contentVisible,
                enter = fadeIn(tween(400)) + slideInVertically(tween(400)) { it / 10 },
            ) {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(3),
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (promoImages.isNotEmpty()) {
                        item(span = { GridItemSpan(maxLineSpan) }) {
                            PromoImageCarousel(images = promoImages)
                        }
                    }

                    if (loading) {
                        item(span = { GridItemSpan(maxLineSpan) }) {
                            CircularProgressIndicator(modifier = Modifier.padding(vertical = 16.dp))
                        }
                    } else if (companies.isEmpty()) {
                        item(span = { GridItemSpan(maxLineSpan) }) {
                            Text(
                                LocalizationManager.tr("No providers available.", "Hadda adeeg lama helin."),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }

                    items(companies, key = { it.id }) { company ->
                        CompanyCard(company = company, onClick = { onOpenCompany(company) })
                    }

                    item(span = { GridItemSpan(maxLineSpan) }) { Spacer(Modifier.height(72.dp)) }
                }
            }
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
            title = { Text(LocalizationManager.tr("Need help?", "Ma u baahan tahay caawimaad?")) },
            text = {
                Column {
                    Text(LocalizationManager.tr("Reach DALAB Internet support directly:", "La xiriir taageerada DALAB Internet:"))
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
            confirmButton = { TextButton(onClick = { showSupport = false }) { Text(LocalizationManager.tr("Close", "Xir")) } },
        )
    }
}

@Composable
private fun HomeHeader(
    customerLabel: String,
    compact: Boolean,
    onOpenNotifications: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val (greetingEn, greetingSo) = remember { greeting() }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                Brush.linearGradient(listOf(HeaderStart, HeaderEnd)),
                shape = RoundedCornerShape(bottomStart = 28.dp, bottomEnd = 28.dp),
            )
            .padding(horizontal = 20.dp, vertical = if (compact) 16.dp else 22.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Box(
                modifier = Modifier
                    .size(if (compact) 44.dp else 52.dp)
                    .clip(CircleShape)
                    .background(Color.White.copy(alpha = 0.18f))
                    .border(1.5.dp, Color.White.copy(alpha = 0.5f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    customerLabel.take(1).uppercase(),
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = if (compact) 18.sp else 20.sp,
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    LocalizationManager.tr(greetingEn, greetingSo),
                    color = Color.White.copy(alpha = 0.85f),
                    fontSize = 13.sp,
                )
                Text(
                    customerLabel,
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = if (compact) 16.sp else 18.sp,
                    maxLines = 1,
                )
            }
            IconButton(onClick = onOpenNotifications) {
                Icon(Icons.Filled.Notifications, contentDescription = "Notifications", tint = Color.White)
            }
            IconButton(onClick = onOpenSettings) {
                Icon(Icons.Filled.Settings, contentDescription = "Settings", tint = Color.White)
            }
        }
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
 * Super Admin-uploaded promotional images (up to 5), shown as a carousel
 * that auto-rotates every few seconds — customers can only view these,
 * never upload, and can still swipe manually at any time (the auto-rotate
 * loop just keys off whatever page is current, so a manual swipe is never
 * fought, only continued from). Each page loads its image from
 * GET /promo-images/{id}/image via Coil (the one place this app needs async
 * remote image loading; provider logos are bundled local drawables instead).
 * Recommended upload size is 1280x658 (the dashboard's upload copy states
 * this too) — the pager uses that exact aspect ratio so a correctly-sized
 * image is never cropped/distorted.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PromoImageCarousel(images: List<PromoImage>) {
    val pagerState = rememberPagerState(pageCount = { images.size })

    LaunchedEffect(pagerState, images.size) {
        if (images.size <= 1) return@LaunchedEffect
        while (true) {
            delay(4000)
            val nextPage = (pagerState.currentPage + 1) % images.size
            pagerState.animateScrollToPage(nextPage)
        }
    }

    Column(modifier = Modifier.padding(bottom = 4.dp)) {
        HorizontalPager(
            state = pagerState,
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(1280f / 658f)
                .shadow(4.dp, RoundedCornerShape(20.dp)),
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
                            .background(if (active) HeaderStart else Color(0xFFD8DCEF)),
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
            HeaderStart
        }
    }
    val logoRes = remember(company.id) { companyLogoRes(company.id) }
    val borderColor = if (offline) Color.LightGray else brandColor

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .shadow(3.dp, RoundedCornerShape(20.dp))
            .clip(RoundedCornerShape(20.dp))
            .background(MaterialTheme.colorScheme.surface)
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
                    .background(MaterialTheme.colorScheme.surface)
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
        Text(company.name, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurface)
        if (offline) {
            Text("Offline", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        }
    }
}
