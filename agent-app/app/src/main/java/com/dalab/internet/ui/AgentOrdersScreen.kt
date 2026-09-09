package com.dalab.internet.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dalab.internet.data.ShopAgentOrder
import com.dalab.internet.data.VipNumberAgentOrder
import com.dalab.internet.data.VipPackageAgentOrder
import com.dalab.internet.network.AgentEventBus
import com.dalab.internet.network.ApiClient
import com.dalab.internet.util.formatApiDateTime
import kotlinx.coroutines.launch

private enum class OrdersTopTab { SHOP, VIP_NUMBERS }
private enum class VipOrdersSubTab { NUMBERS, PACKAGES }

/**
 * The Agent App's real Orders tab — Shop | VIP Numbers, with VIP Numbers
 * further split Numbers | Packages (mirroring the Admin Dashboard's own
 * "Orders / Package Orders" tabs, since a package order is a distinct
 * resource, not just a numbers-order row with extra numbers attached).
 * Every list here is real backend data (GET agent/shop/orders,
 * GET agent/vip-numbers/orders, GET agent/vip-numbers/packages/orders) --
 * nothing fabricated/local-only. A paid order shows up here the moment an
 * admin confirms payment server-side; the payment-confirmed push (see
 * AgentFcmService) is what tells the agent to come look, this screen's own
 * refresh (pull-to-refresh, the refresh action, or the shared
 * AgentEventBus.orderEvents signal other order flows already emit on) is
 * what actually shows it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentOrdersScreen(
    onOpenShopOrder: (ShopAgentOrder) -> Unit,
    onOpenVipOrder: (VipNumberAgentOrder) -> Unit,
    onOpenVipPackageOrder: (VipPackageAgentOrder) -> Unit,
) {
    var topTab by remember { mutableStateOf(OrdersTopTab.SHOP) }
    var vipSubTab by remember { mutableStateOf(VipOrdersSubTab.NUMBERS) }

    var shopOrders by remember { mutableStateOf<List<ShopAgentOrder>>(emptyList()) }
    var vipOrders by remember { mutableStateOf<List<VipNumberAgentOrder>>(emptyList()) }
    var vipPackageOrders by remember { mutableStateOf<List<VipPackageAgentOrder>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()

    fun refresh() {
        loading = true
        scope.launch {
            try {
                when (topTab) {
                    OrdersTopTab.SHOP -> shopOrders = ApiClient.service.getAgentShopOrders().body().orEmpty()
                    OrdersTopTab.VIP_NUMBERS -> when (vipSubTab) {
                        VipOrdersSubTab.NUMBERS -> vipOrders = ApiClient.service.getAgentVipNumberOrders().body().orEmpty()
                        VipOrdersSubTab.PACKAGES -> vipPackageOrders = ApiClient.service.getAgentVipPackageOrders().body().orEmpty()
                    }
                }
            } catch (_: Exception) {
                // Leave whatever list is currently showing in place.
            }
            loading = false
        }
    }

    LaunchedEffect(topTab, vipSubTab) { refresh() }
    // Same shared real-time signal every other order flow (Internet Store,
    // Money Exchange) already refreshes on -- if that stream is ever
    // extended to Shop/VIP order events this screen picks it up for free;
    // until then it's still a safety net alongside the explicit refresh
    // button and pull-to-refresh below.
    LaunchedEffect(Unit) { AgentEventBus.orderEvents.collect { refresh() } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Orders", fontWeight = FontWeight.Bold)
                        Text(
                            "Track and manage your orders",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    Box(
                        modifier = Modifier.padding(end = 12.dp)
                            .size(40.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(MaterialTheme.colorScheme.primaryContainer)
                            .clickable(onClick = ::refresh),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Filled.Refresh,
                            contentDescription = "Refresh",
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                },
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            TabRow(selectedTabIndex = topTab.ordinal) {
                Tab(
                    selected = topTab == OrdersTopTab.SHOP,
                    onClick = { topTab = OrdersTopTab.SHOP },
                    text = { Text("Shop", fontWeight = if (topTab == OrdersTopTab.SHOP) FontWeight.Bold else FontWeight.Normal) },
                )
                Tab(
                    selected = topTab == OrdersTopTab.VIP_NUMBERS,
                    onClick = { topTab = OrdersTopTab.VIP_NUMBERS },
                    text = { Text("VIP Numbers", fontWeight = if (topTab == OrdersTopTab.VIP_NUMBERS) FontWeight.Bold else FontWeight.Normal) },
                )
            }

            if (topTab == OrdersTopTab.VIP_NUMBERS) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    SubTabPill(
                        label = "Numbers",
                        selected = vipSubTab == VipOrdersSubTab.NUMBERS,
                        onClick = { vipSubTab = VipOrdersSubTab.NUMBERS },
                    )
                    SubTabPill(
                        label = "Packages",
                        selected = vipSubTab == VipOrdersSubTab.PACKAGES,
                        onClick = { vipSubTab = VipOrdersSubTab.PACKAGES },
                    )
                }
            }

            Box(modifier = Modifier.fillMaxSize()) {
                val isEmpty = when (topTab) {
                    OrdersTopTab.SHOP -> shopOrders.isEmpty()
                    OrdersTopTab.VIP_NUMBERS -> when (vipSubTab) {
                        VipOrdersSubTab.NUMBERS -> vipOrders.isEmpty()
                        VipOrdersSubTab.PACKAGES -> vipPackageOrders.isEmpty()
                    }
                }
                if (loading && isEmpty) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                } else if (isEmpty) {
                    Text("No orders yet.", modifier = Modifier.align(Alignment.Center), style = MaterialTheme.typography.bodyMedium)
                } else {
                    LazyColumn {
                        when (topTab) {
                            OrdersTopTab.SHOP -> items(shopOrders, key = { it.id }) { order ->
                                ShopOrderRow(order = order, onClick = { onOpenShopOrder(order) })
                                Divider()
                            }
                            OrdersTopTab.VIP_NUMBERS -> when (vipSubTab) {
                                VipOrdersSubTab.NUMBERS -> items(vipOrders, key = { it.id }) { order ->
                                    VipNumberOrderRow(order = order, onClick = { onOpenVipOrder(order) })
                                    Divider()
                                }
                                VipOrdersSubTab.PACKAGES -> items(vipPackageOrders, key = { it.id }) { order ->
                                    VipPackageOrderRow(order = order, onClick = { onOpenVipPackageOrder(order) })
                                    Divider()
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ShopOrderRow(order: ShopAgentOrder, onClick: () -> Unit) {
    OrderRowCard(
        title = order.id,
        subtitle = order.customerName ?: "Unknown customer",
        amount = order.totalAmount?.toDoubleOrNull() ?: 0.0,
        dateText = formatApiDateTime(order.createdAt),
        status = order.status,
        paymentStatus = order.paymentStatus,
        onClick = onClick,
    )
}

@Composable
private fun VipNumberOrderRow(order: VipNumberAgentOrder, onClick: () -> Unit) {
    OrderRowCard(
        title = order.phoneNumber ?: order.id,
        subtitle = order.customerFullName ?: order.customerName ?: "Unknown customer",
        amount = order.price?.toDoubleOrNull() ?: 0.0,
        dateText = formatApiDateTime(order.createdAt),
        status = order.status,
        paymentStatus = order.paymentStatus,
        onClick = onClick,
    )
}

@Composable
private fun VipPackageOrderRow(order: VipPackageAgentOrder, onClick: () -> Unit) {
    OrderRowCard(
        title = "${order.size ?: "?"} Numbers Package",
        subtitle = order.customerFullName ?: order.customerName ?: "Unknown customer",
        amount = order.price?.toDoubleOrNull() ?: 0.0,
        dateText = formatApiDateTime(order.createdAt),
        status = order.status,
        paymentStatus = order.paymentStatus,
        onClick = onClick,
    )
}

/** Shared list-row layout for every order type on this screen -- leading
 * phone-icon circle (tinted green once the order is actually Completed,
 * primary-tinted otherwise), title/subtitle, amount, a calendar-prefixed
 * date line, and the colored [AgentOrderStatusPill] this row resolves to.
 * The trailing "more" glyph is deliberately a plain [Icon] (not an
 * [IconButton]) -- there's no menu behind it yet, so it stays inert rather
 * than implying a tappable action that does nothing. */
@Composable
private fun OrderRowCard(
    title: String,
    subtitle: String,
    amount: Double,
    dateText: String,
    status: String?,
    paymentStatus: String?,
    onClick: () -> Unit,
) {
    val (statusLabel, statusColors) = agentOrderStatus(status, paymentStatus)
    Column(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp)) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                Box(
                    modifier = Modifier.size(44.dp)
                        .clip(CircleShape)
                        .background(statusColors.circleBg),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.Phone, contentDescription = null, tint = statusColors.circleFg, modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.width(12.dp))
                Column {
                    Text(title, fontWeight = FontWeight.Bold)
                    Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("$${"%.2f".format(amount)}", fontWeight = FontWeight.Bold)
                    Spacer(Modifier.width(4.dp))
                    Icon(
                        Icons.Filled.MoreVert,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.CalendarToday,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(dateText, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            AgentOrderStatusPill(statusLabel, statusColors)
        }
    }
}

private data class StatusColors(val bg: Color, val fg: Color, val circleBg: Color, val circleFg: Color, val icon: ImageVector)

/** Plain string status/paymentStatus (see AgentOrdersModels.kt's own
 * comment on why) -- this maps whatever the backend sent to a label and a
 * color/icon treatment, defaulting to a neutral gray for anything it
 * doesn't specifically recognize rather than guessing. */
@Composable
private fun agentOrderStatus(status: String?, paymentStatus: String?): Pair<String, StatusColors> {
    val label = when {
        paymentStatus != null && paymentStatus != "paid" -> "Unpaid"
        status != null -> status.replaceFirstChar { it.uppercase() }
        else -> "—"
    }
    val colors = when (label.lowercase()) {
        "completed" -> StatusColors(
            bg = Color(0xFFDCFCE7), fg = Color(0xFF16A34A),
            circleBg = Color(0xFFDCFCE7), circleFg = Color(0xFF16A34A),
            icon = Icons.Filled.CheckCircle,
        )
        "unpaid", "failed", "cancelled" -> StatusColors(
            bg = Color(0xFFFEE2E2), fg = Color(0xFFDC2626),
            circleBg = MaterialTheme.colorScheme.primaryContainer, circleFg = MaterialTheme.colorScheme.primary,
            icon = Icons.Filled.Error,
        )
        else -> StatusColors(
            bg = Color(0xFFFFEDD5), fg = Color(0xFFC2410C),
            circleBg = MaterialTheme.colorScheme.primaryContainer, circleFg = MaterialTheme.colorScheme.primary,
            icon = Icons.Filled.Schedule,
        )
    }
    return label to colors
}

@Composable
private fun AgentOrderStatusPill(label: String, colors: StatusColors) {
    Surface(color = colors.bg, shape = RoundedCornerShape(50)) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(colors.icon, contentDescription = null, tint = colors.fg, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(6.dp))
            Text(label, color = colors.fg, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun SubTabPill(label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(50),
        color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
    ) {
        Text(
            label,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}
