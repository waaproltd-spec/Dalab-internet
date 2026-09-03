package com.dalab.internet.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
                title = { Text("Orders") },
                actions = {
                    IconButton(onClick = ::refresh) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
                },
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            TabRow(selectedTabIndex = topTab.ordinal) {
                Tab(selected = topTab == OrdersTopTab.SHOP, onClick = { topTab = OrdersTopTab.SHOP }, text = { Text("Shop") })
                Tab(selected = topTab == OrdersTopTab.VIP_NUMBERS, onClick = { topTab = OrdersTopTab.VIP_NUMBERS }, text = { Text("VIP Numbers") })
            }

            if (topTab == OrdersTopTab.VIP_NUMBERS) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    FilterChip(
                        selected = vipSubTab == VipOrdersSubTab.NUMBERS,
                        onClick = { vipSubTab = VipOrdersSubTab.NUMBERS },
                        label = { Text("Numbers") },
                    )
                    FilterChip(
                        selected = vipSubTab == VipOrdersSubTab.PACKAGES,
                        onClick = { vipSubTab = VipOrdersSubTab.PACKAGES },
                        label = { Text("Packages") },
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
    Column(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp)) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Column {
                Text(order.id, fontWeight = FontWeight.Bold)
                Text(order.customerName ?: "Unknown customer", style = MaterialTheme.typography.bodySmall)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("$${"%.2f".format(order.totalAmount?.toDoubleOrNull() ?: 0.0)}", fontWeight = FontWeight.Bold)
                AgentOrderStatusChip(order.status, order.paymentStatus)
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(formatApiDateTime(order.createdAt), style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun VipNumberOrderRow(order: VipNumberAgentOrder, onClick: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp)) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Column {
                Text(order.phoneNumber ?: order.id, fontWeight = FontWeight.Bold)
                Text(order.customerFullName ?: order.customerName ?: "Unknown customer", style = MaterialTheme.typography.bodySmall)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("$${"%.2f".format(order.price?.toDoubleOrNull() ?: 0.0)}", fontWeight = FontWeight.Bold)
                AgentOrderStatusChip(order.status, order.paymentStatus)
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(formatApiDateTime(order.createdAt), style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun VipPackageOrderRow(order: VipPackageAgentOrder, onClick: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp)) {
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Column {
                Text("${order.size ?: "?"} Numbers Package", fontWeight = FontWeight.Bold)
                Text(order.customerFullName ?: order.customerName ?: "Unknown customer", style = MaterialTheme.typography.bodySmall)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("$${"%.2f".format(order.price?.toDoubleOrNull() ?: 0.0)}", fontWeight = FontWeight.Bold)
                AgentOrderStatusChip(order.status, order.paymentStatus)
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(formatApiDateTime(order.createdAt), style = MaterialTheme.typography.labelSmall)
    }
}

/** Shared status pill for every list row in this screen — plain string
 * status/paymentStatus (see AgentOrdersModels.kt's own comment on why),
 * so this just title-cases whatever the backend sent rather than
 * maintaining a parallel label map that could drift out of sync with it. */
@Composable
private fun AgentOrderStatusChip(status: String?, paymentStatus: String?) {
    val label = when {
        paymentStatus != null && paymentStatus != "paid" -> "Unpaid"
        status != null -> status.replaceFirstChar { it.uppercase() }
        else -> "—"
    }
    AssistChip(onClick = {}, label = { Text(label) })
}
