package com.dalab.internet.notifications

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Same tap-to-open pattern as SupportDeepLink, for a payment-confirmed
 * Shop/VIP Number/VIP Package order push (data.screen == "agent_orders" --
 * see shop.routes.ts/vipNumbers.routes.ts/vipNumberPackages.routes.ts's
 * sendPushToAllAgents() calls and AgentFcmService's handling of them).
 * No orderId/orderType is threaded through: tapping just needs to land the
 * agent on the Orders tab, where the real list (already refreshed on open)
 * shows whatever is newly payable/completable.
 */
object OrdersDeepLink {
    var pending by mutableStateOf(false)
}
