package com.dalab.internet.notifications

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Same tap-to-open pattern as SupportDeepLink, for a payment-confirmed
 * Shop/VIP Number/VIP Package order push (data.screen == "agent_orders" --
 * see shop.routes.ts/vipNumbers.routes.ts/vipNumberPackages.routes.ts/
 * vipNumberSmsMatching.ts's sendPushToAllAgents() calls and
 * AgentFcmService's handling of them).
 *
 * orderId/orderType carry the specific order the push was about (both are
 * always present in the FCM data payload for every one of those call
 * sites) so a tap can jump straight to that order's own detail screen
 * instead of just the Orders tab's list -- see MainActivity.kt's
 * AgentApp() composable, which fetches the order and navigates directly
 * for orderType "vip_number"/"vip_package" (VIP Complete Order requires
 * seeing the order in question -- Shop orders have no equivalent
 * requirement, so a "shop" push still just opens the Orders tab, same as
 * before). Cleared together with [pending] once consumed, or left null on
 * a generic push (or an older app build's queued notification) so the
 * Orders-tab fallback still applies.
 */
object OrdersDeepLink {
    var pending by mutableStateOf(false)
    var orderType by mutableStateOf<String?>(null)
    var orderId by mutableStateOf<String?>(null)
}
