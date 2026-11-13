package com.dalab.internet.ui

import com.dalab.internet.ui.i18n.Text
import android.Manifest
import android.content.pm.PackageManager
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SettingsInputAntenna
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.data.AgentBalanceEntry
import com.dalab.internet.data.Order
import com.dalab.internet.data.OrderStatus
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.R
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.ConnectionState
import com.dalab.internet.notifications.AgentAlertsState
import com.dalab.internet.service.AgentBackgroundService
import com.dalab.internet.support.SupportQueueState
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import com.dalab.internet.ui.theme.DalabBrandFill
import com.dalab.internet.ui.theme.DalabBrandFillLight
import com.dalab.internet.ui.theme.DalabMuted
import com.dalab.internet.ui.theme.DalabSurfaceTint
import com.dalab.internet.ui.theme.DalabWhite

// DALAB brand — Dark Azure + Soft Blue, shared with the Customer App and
// Admin Dashboard. Re-exported here (under the names this module's screens
// already call them by) from ui/theme/DalabColors.kt, the one place any of
// these hex values is actually defined -- see that file's own header
// comment. DalabGreen stays separate: it's the functional success/
// money-earned color (order-amount text further down), not brand, per the
// shared two-color rule's own carve-out. Internal (not private) so other
// Home-adjacent screens in this module can match the brand exactly.
internal val DalabIndigo: Color @Composable @ReadOnlyComposable get() = com.dalab.internet.ui.theme.DalabBlue
internal val DalabSoftBlue: Color @Composable @ReadOnlyComposable get() = com.dalab.internet.ui.theme.DalabSoftBlue
internal val DalabGreen: Color @Composable @ReadOnlyComposable get() = com.dalab.internet.ui.theme.DalabSuccessGreen
internal val DalabAmber: Color @Composable @ReadOnlyComposable get() = com.dalab.internet.ui.theme.DalabWarningAmber
internal val DalabRed: Color @Composable @ReadOnlyComposable get() = com.dalab.internet.ui.theme.DalabDangerRed
internal val DalabBrandBlue: Color @Composable @ReadOnlyComposable get() = com.dalab.internet.ui.theme.DalabInfoBlue

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrdersListScreen(
    onOpenOrder: (Order) -> Unit,
    onOpenAlerts: () -> Unit = {},
) {
    val context = LocalContext.current
    var lastSyncedAt by remember { mutableStateOf<Date?>(null) }
    var balances by remember { mutableStateOf<List<AgentBalanceEntry>>(emptyList()) }
    var balancesLoading by remember { mutableStateOf(true) }
    var simBalances by remember { mutableStateOf<List<com.dalab.internet.data.SimBalance>?>(null) }
    var simBalancesError by remember { mutableStateOf<String?>(null) }
    val connectionState by AgentEventBus.connectionState.collectAsState()
    val unreadAlerts by AgentAlertsState.unreadCount.collectAsState()
    val scope = rememberCoroutineScope()

    fun smsListeningActive(): Boolean {
        val readGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED
        val receiveGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        return readGranted && receiveGranted && AgentBackgroundService.isRunning
    }
    var listeningActive by remember { mutableStateOf(smsListeningActive()) }

    fun refreshDashboard() {
        listeningActive = smsListeningActive()
        scope.launch {
            try {
                val notifications = ApiClient.service.getNotifications().body().orEmpty().distinctBy { it.id }
                AgentAlertsState.updateUnreadCount(notifications)
            } catch (_: Exception) {
                // Badge just keeps its last known count on failure.
            }
            try {
                // Any agent (online or not) can see how many customers are
                // waiting -- requireSupportActor() only gates claiming, not
                // viewing the queue -- so this is safe to fetch unconditionally.
                val supportQueue = ApiClient.service.getSupportQueue().body().orEmpty()
                SupportQueueState.update(supportQueue)
            } catch (_: Exception) {
                // Badge just keeps its last known count on failure.
            }
        }
    }

    // Real balance data from the same SMS/manual balance pipeline the Super
    // Admin's Balance Dashboard uses -- no mock or hardcoded values. Kept
    // separate from refreshDashboard() above (notifications/support queue)
    // since a balances-fetch failure shouldn't touch those badges' state,
    // and vice versa -- each keeps its last known good value independently.
    fun refreshBalances() {
        scope.launch {
            try {
                // Per-SIM list first; a system not updated yet answers 404
                // and the network totals below are shown as before.
                val sims = ApiClient.service.getSimBalances()
                if (sims.isSuccessful) {
                    simBalances = sims.body()?.sims.orEmpty()
                    simBalancesError = null
                } else if (sims.code() == 404) {
                    simBalances = null
                    balances = ApiClient.service.getAgentBalances().body().orEmpty()
                } else {
                    simBalancesError = "Couldn't load SIM balances (HTTP ${sims.code()})."
                }
                lastSyncedAt = Date()
            } catch (_: Exception) {
                // Keep the last known balances; say they couldn't be refreshed.
                simBalancesError = "No connection — showing the last balances received."
            }
            balancesLoading = false
        }
    }
    LaunchedEffect(Unit) { refreshDashboard() }
    LaunchedEffect(Unit) { refreshBalances() }
    // Real-time push: AgentBackgroundService owns the single SSE connection
    // (so it keeps running even off this screen / in the background) and
    // broadcasts here on every order change anywhere (customer app, another
    // agent, the dashboard) instead of this screen opening its own connection.
    LaunchedEffect(Unit) { AgentEventBus.orderEvents.collect { refreshBalances() } }
    LaunchedEffect(Unit) { AgentEventBus.orderEvents.collect { refreshDashboard() } }

    // Home is balance-only now -- the Pending/Completed/All dial queue that
    // used to live below the balance section was removed per product
    // decision (superseded by the Shop/VIP order flow on the Orders tab);
    // onOpenOrder is kept as a parameter only because OrderDetailScreen's
    // navigation wiring in MainActivity still references it.
    Scaffold { padding ->
        LazyColumn(modifier = Modifier.padding(padding).fillMaxSize()) {
            item {
                AgentHomeHeader(
                    agentName = remember { SessionManager.currentAgent()?.name },
                    listeningActive = listeningActive,
                    connectionState = connectionState,
                    lastSyncedAt = lastSyncedAt,
                    unreadAlerts = unreadAlerts,
                    onRefresh = { refreshDashboard(); refreshBalances() },
                    onOpenAlerts = onOpenAlerts,
                )
            }

            item {
                val sims = simBalances
                AgentBalanceSection(
                    cards = if (sims != null) balanceCardsFromSims(sims) else balances.map { BalanceCardData(it.providerKey, it.providerName, it.category, it.balance, null, false, emptyList(), configured = true) },
                    loading = balancesLoading,
                    error = simBalancesError,
                )
            }
        }
    }
}

// Compact brand header: identity + the two things an agent actually needs
// to see at a glance (is the SMS listener running, is the live connection
// up) collapsed into a single status bar instead of two separate cards.
// Today's Sales/Orders and the Recent Activity feed used to live here too —
// removed as duplicated with the Reports tab (which already has a "Today"
// range) and the orders list immediately below, per the Home redesign.
@Composable
private fun AgentHomeHeader(
    agentName: String?,
    listeningActive: Boolean,
    connectionState: ConnectionState,
    lastSyncedAt: Date?,
    unreadAlerts: Int,
    onRefresh: () -> Unit,
    onOpenAlerts: () -> Unit,
) {
    val infiniteTransition = rememberInfiniteTransition(label = "listening-pulse")
    val pulseScale by infiniteTransition.animateFloat(
        initialValue = 0.85f,
        targetValue = 1.15f,
        animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Reverse),
        label = "listening-pulse-scale",
    )

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                com.dalab.internet.ui.WaaproHeaderBrush,
                shape = RoundedCornerShape(bottomStart = 24.dp, bottomEnd = 24.dp),
            )
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(
                    painter = painterResource(com.dalab.internet.auth.SystemBrand.logo()),
                    contentDescription = null,
                    modifier = Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(Color.White).padding(2.dp),
                )
                Spacer(Modifier.width(10.dp))
                Column {
                    Text(com.dalab.internet.ui.WAAPRO_APP_NAME, color = Color.White, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                    Text(
                        agentName?.let { "Welcome back, $it" } ?: "Welcome back",
                        color = Color.White.copy(alpha = 0.85f),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                NotificationBellButton(unreadCount = unreadAlerts, onClick = onOpenAlerts)
                IconButton(onClick = onRefresh) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = Color.White)
                }
            }
        }

        Spacer(Modifier.height(6.dp))

        Surface(color = Color.White.copy(alpha = 0.15f), shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
            Row(modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .scale(if (listeningActive) pulseScale else 1f)
                        .background(Color.White.copy(alpha = if (listeningActive) 0.25f else 0.12f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.SettingsInputAntenna, contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
                }
                Spacer(Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        if (listeningActive) "SMS Listening — Active" else "SMS Listening — Inactive",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        if (listeningActive) "Monitoring payment SMS" else "Grant SMS permissions in More → Permissions",
                        color = Color.White.copy(alpha = 0.8f),
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                Spacer(Modifier.width(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val (dotColor, label) = when (connectionState) {
                        ConnectionState.CONNECTED -> Color(0xFF6FE39A) to "Connected"
                        ConnectionState.CONNECTING -> Color(0xFFF2C200) to "Reconnecting…"
                        ConnectionState.DISCONNECTED -> Color(0xFFF87171) to "Disconnected"
                    }
                    Icon(Icons.Filled.Circle, contentDescription = null, tint = dotColor, modifier = Modifier.size(7.dp))
                    Spacer(Modifier.width(5.dp))
                    Column {
                        Text(label, color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.labelSmall)
                        lastSyncedAt?.let {
                            Text(
                                SimpleDateFormat("HH:mm:ss", Locale.US).format(it),
                                color = Color.White.copy(alpha = 0.7f),
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun NotificationBellButton(unreadCount: Int, onClick: () -> Unit) {
    IconButton(onClick = onClick) {
        BadgedBox(badge = {
            if (unreadCount > 0) {
                Badge(containerColor = Color(0xFFF87171)) {
                    Text(if (unreadCount > 9) "9+" else unreadCount.toString())
                }
            }
        }) {
            Icon(Icons.Filled.Notifications, contentDescription = "Notifications", tint = Color.White)
        }
    }
}

// Home screen's Agent Balance section, replacing the old Wallet/Money
// Exchange quick-action cards -- both are still reachable from the More
// tab (MainActivity's MoreScreen), unchanged. Payment Method (EVC Plus/
// eDahab -- balances used for receiving customer payments) and Payment
// Company (Hormuud/Somnet/Somtel/Amtel -- balances used for sending data/
// airtime) are always shown as their own labeled group with its own Total
// Balance summary, matching the reference design, regardless of which
// ones this specific agent has ever dialed through.
/** One logo card: a network's total from its admin-configured SIMs. amount
 * is null when none of its SIMs has a confirmed balance (shown "Unknown",
 * or "Not set up" when the admin configured no SIM for it) -- never $0. */
data class BalanceCardData(
    val providerKey: String,
    val providerName: String,
    val category: String,
    val amount: Double?,
    val note: String?,
    val attention: Boolean,
    val sims: List<com.dalab.internet.data.SimBalance>,
    val configured: Boolean,
)

private val CARD_ORDER = listOf(
    Triple("evc_plus", "EVC Plus", "method"),
    Triple("edahab", "eDahab", "method"),
    Triple("hormuud", "Hormuud", "company"),
    Triple("somnet", "Somnet", "company"),
    Triple("somtel", "Somtel", "company"),
    Triple("amtel", "Amtel", "company"),
)

/** The six logo cards from the per-SIM list. Pure; unit-tested. Hormuud's
 * E-Voucher stock is listed under Hormuud but not added to its data total. */
fun balanceCardsFromSims(sims: List<com.dalab.internet.data.SimBalance>): List<BalanceCardData> =
    CARD_ORDER.map { (key, name, category) ->
        val own = sims.filter { it.providerKey == key }
        val listed = if (key == "hormuud") own + sims.filter { it.providerKey == "hormuud_evoucher" } else own
        val known = own.mapNotNull { it.balance }
        val needCheck = listed.count { it.status != "ok" }
        BalanceCardData(
            providerKey = key,
            providerName = name,
            category = category,
            amount = if (known.isEmpty()) null else known.sum(),
            note = when {
                listed.isEmpty() -> null
                needCheck > 0 -> if (needCheck == 1) "1 SIM needs check" else "$needCheck SIMs need check"
                // One SIM: show WHICH one (its number and slot), not a count
                // that reads like "SIM 1".
                listed.size == 1 -> listOfNotNull(listed[0].phoneNumber, "SIM ${listed[0].simSlot}").joinToString(" · ")
                else -> "${listed.size} SIMs"
            },
            attention = needCheck > 0,
            sims = listed,
            configured = listed.isNotEmpty(),
        )
    }

private fun cardAmountText(c: BalanceCardData, loading: Boolean): String = when {
    loading -> "…"
    c.amount != null -> "$ ${"%.2f".format(c.amount)}"
    !c.configured -> "Not set up"
    else -> "Unknown"
}

@Composable
private fun AgentBalanceSection(cards: List<BalanceCardData>, loading: Boolean, error: String? = null) {
    val methodCards = cards.filter { it.category == "method" }
    val companyCards = cards.filter { it.category == "company" }
    var expanded by remember { mutableStateOf<String?>(null) }
    val toggle: (String) -> Unit = { key -> expanded = if (expanded == key) null else key }

    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp)) {
        GrandTotalBar(
            methods = methodCards.sumOf { it.amount ?: 0.0 },
            companies = companyCards.sumOf { it.amount ?: 0.0 },
            loading = loading,
        )
        error?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, color = Color(0xFFB42318), style = MaterialTheme.typography.labelMedium)
        }
        Spacer(Modifier.height(6.dp))
        BalanceGroupHeader(
            title = "Payment Method (${methodCards.size})",
            totalBalance = methodCards.sumOf { it.amount ?: 0.0 },
            loading = loading,
            accentColor = DalabGreen,
        )
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            methodCards.forEach { card ->
                PaymentMethodCard(card = card, loading = loading, onClick = { toggle(card.providerKey) }, modifier = Modifier.weight(1f))
            }
        }
        methodCards.firstOrNull { it.providerKey == expanded }?.let { CardSims(it) }

        Spacer(Modifier.height(6.dp))

        BalanceGroupHeader(
            title = "Payment Company (${companyCards.size})",
            totalBalance = companyCards.sumOf { it.amount ?: 0.0 },
            loading = loading,
            accentColor = DalabBrandBlue,
        )
        Spacer(Modifier.height(6.dp))
        companyCards.chunked(2).forEach { rowCards ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                rowCards.forEach { card ->
                    PaymentCompanyCard(card = card, loading = loading, onClick = { toggle(card.providerKey) }, modifier = Modifier.weight(1f))
                }
                if (rowCards.size == 1) Spacer(modifier = Modifier.weight(1f))
            }
            rowCards.firstOrNull { it.providerKey == expanded }?.let { CardSims(it) }
        }
    }
}

/** The tapped card's SIMs: number, phone, slot, last update, real errors. */
@Composable
private fun CardSims(card: BalanceCardData) {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (card.sims.isEmpty()) {
            Text(
                "No ${card.providerName} SIM has been set up by the admin (Balance Dashboard / SIM Routing).",
                color = DalabMuted, style = MaterialTheme.typography.bodySmall,
            )
        } else {
            card.sims.forEach { SimBalanceRow(it) }
        }
    }
}

// The section title plus its own right-aligned Total Balance summary --
// accentColor lets Payment Method (green) and Payment Company (blue) each
// read as their own group at a glance, matching the reference design. No
// subtitle/description line under the title, per the current design spec.
/** Everything together: payment methods + payment companies. */
@Composable
private fun GrandTotalBar(methods: Double, companies: Double, loading: Boolean) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(com.dalab.internet.ui.WaaproHeaderBrush)
            .padding(horizontal = 14.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text("Total Balance (all)", color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.labelMedium)
            Text(
                if (loading) "…" else "Methods $${"%.2f".format(methods)} + Companies $${"%.2f".format(companies)}",
                color = Color.White.copy(alpha = 0.75f),
                style = MaterialTheme.typography.labelSmall,
            )
        }
        Text(
            if (loading) "…" else "$ ${"%.2f".format(methods + companies)}",
            color = com.dalab.internet.ui.WaaproGold,
            fontWeight = FontWeight.Black,
            style = MaterialTheme.typography.titleLarge,
        )
    }
}

@Composable
private fun BalanceGroupHeader(title: String, totalBalance: Double, loading: Boolean, accentColor: Color) {
    // One line (title left, total right) so Home fits on one screen.
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = DalabIndigo)
        Text(
            if (loading) "…" else "$ ${"%.2f".format(totalBalance)}",
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.Bold,
            color = accentColor,
        )
    }
}

/** Maps a provider_key to its real bundled brand logo -- see
 * app/src/main/res/drawable/logo_*.png, sourced from the same real brand
 * marks confirmed against the customer-facing apps (never a mock/generic
 * icon). Falls back to the DALAB wordmark only if a 7th key is ever added
 * here without a matching asset. */
@androidx.annotation.DrawableRes
internal fun logoResFor(providerKey: String): Int = when (providerKey) {
    "evc_plus" -> R.drawable.logo_evc_plus
    "edahab" -> R.drawable.logo_edahab
    "hormuud" -> R.drawable.logo_hormuud
    "somnet" -> R.drawable.logo_somnet
    "somtel" -> R.drawable.logo_somtel
    "amtel" -> R.drawable.logo_amtel
    else -> com.dalab.internet.auth.SystemBrand.logo()
}

/** Each provider's brand color for the balance cards below. Fixed brand
 * colors on purpose -- NOT the theme-dependent Dalab* colors: a provider's
 * card must look the same (and keep readable white/navy text) in Light and
 * Dark mode and with any Theme color. Same hues the Customer App uses. */
private fun providerBrandColor(providerKey: String): Color = when (providerKey) {
    "evc_plus", "hormuud" -> ProviderGreen
    "edahab", "somtel" -> ProviderYellow
    "somnet" -> ProviderBlue
    "amtel" -> ProviderRed
    else -> ProviderNavy
}

private val ProviderGreen = Color(0xFF16A34A)
private val ProviderYellow = Color(0xFFF2C200)
private val ProviderBlue = Color(0xFF1D4ED8)
private val ProviderRed = Color(0xFFC81E2C)
private val ProviderNavy = Color(0xFF0A3B63)

// Payment Method card (EVC Plus/eDahab): white card with a soft brand-color
// wash behind the logo and a colored balance figure -- these are the
// balances an agent *receives* customer payments into, so they stay light
// and read primarily through their logo, same as the reference design.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PaymentMethodCard(card: BalanceCardData, loading: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val accent = providerBrandColor(card.providerKey)
    Surface(onClick = onClick, color = DalabWhite, shape = RoundedCornerShape(18.dp), shadowElevation = 1.dp, modifier = modifier) {
        Box {
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .size(96.dp)
                    .offset(x = 28.dp, y = 28.dp)
                    .clip(CircleShape)
                    .background(accent.copy(alpha = 0.14f)),
            )
            Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp)) {
                Image(
                    painter = painterResource(logoResFor(card.providerKey)),
                    contentDescription = card.providerName,
                    contentScale = ContentScale.Fit,
                    alignment = Alignment.CenterStart,
                    modifier = Modifier.height(18.dp).fillMaxWidth(0.72f),
                )
                Spacer(Modifier.height(3.dp))
                Text(card.providerName, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, color = DalabIndigo)
                Spacer(Modifier.height(1.dp))
                Text(
                    cardAmountText(card, loading),
                    style = if (card.amount != null || loading) MaterialTheme.typography.titleMedium else MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    // eDahab's yellow is too light to read as text on a white
                    // card -- a deeper gold keeps the same hue, readable.
                    color = if (card.amount == null && !loading) DalabMuted else if (accent == ProviderYellow) Color(0xFFB8860B) else accent,
                )
                card.note?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = if (card.attention) Color(0xFFB42318) else DalabMuted)
                }
            }
            Box(
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .padding(end = 10.dp)
                    .size(28.dp)
                    .clip(CircleShape)
                    .background(DalabSurfaceTint),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = DalabIndigo, modifier = Modifier.size(18.dp))
            }
        }
    }
}

// Payment Company card (Hormuud/Somnet/Somtel/Amtel): the full card is the
// company's own brand color -- these are the balances an agent *spends*
// dialing data/airtime out, so they read as bold, distinct blocks of
// color, matching the reference design. The balance figure is tinted to
// match its own card rather than the single hardcoded green every card
// used before, fixing the mismatch (e.g. a red Amtel card previously still
// showing a green balance).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PaymentCompanyCard(card: BalanceCardData, loading: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val brand = providerBrandColor(card.providerKey)
    // Somtel's brand color is a bright yellow -- white text on it reads
    // poorly, so it's the one company card using dark text instead of
    // white, matching the reference design's own contrast choice.
    // Fixed navy (not the theme's text color, which turns light in Dark mode).
    val onBrand = if (card.providerKey == "somtel") ProviderNavy else Color.White
    Surface(onClick = onClick, color = brand, shape = RoundedCornerShape(18.dp), shadowElevation = 1.dp, modifier = modifier) {
        Box {
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .size(90.dp)
                    .offset(x = 26.dp, y = 26.dp)
                    .clip(CircleShape)
                    .background(Color.White.copy(alpha = 0.08f)),
            )
            Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp)) {
                Box(
                    modifier = Modifier.size(26.dp).clip(RoundedCornerShape(8.dp)).background(Color.White),
                    contentAlignment = Alignment.Center,
                ) {
                    Image(
                        painter = painterResource(logoResFor(card.providerKey)),
                        contentDescription = card.providerName,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.size(20.dp).clip(RoundedCornerShape(5.dp)),
                    )
                }
                Spacer(Modifier.height(3.dp))
                Text(card.providerName, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, color = onBrand)
                Spacer(Modifier.height(1.dp))
                Text(
                    cardAmountText(card, loading),
                    style = if (card.amount != null || loading) MaterialTheme.typography.titleMedium else MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color = onBrand,
                )
                card.note?.let {
                    Text(if (card.attention) "⚠ $it" else it, style = MaterialTheme.typography.labelSmall, color = onBrand.copy(alpha = 0.9f))
                }
            }
            Box(
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .padding(end = 10.dp)
                    .size(28.dp)
                    .clip(CircleShape)
                    .background(Color.White.copy(alpha = 0.9f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = brand, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
fun StatusChip(order: Order) {
    // "in_progress" is one status in the data model, but reads better to an
    // agent split into whether the USSD string has actually been generated
    // yet (dial about to/already in flight) vs. still waiting on that step —
    // cosmetic only, no change to the underlying OrderStatus.
    val label = when {
        order.status == OrderStatus.PENDING -> "Pending"
        order.status == OrderStatus.IN_PROGRESS -> if (order.ussdGenerated != null) "Delivering" else "Processing"
        order.status == OrderStatus.COMPLETED -> "Completed"
        order.status == OrderStatus.FAILED -> "Failed"
        else -> "Cancelled"
    }
    AssistChip(onClick = {}, label = { Text(label) })
}
