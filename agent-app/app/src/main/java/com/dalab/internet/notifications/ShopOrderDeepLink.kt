package com.dalab.internet.notifications

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Compose-observable flag set the instant a "💰 Payment Received" push
 * (admin-backend-ts's shopSmsMatching.ts, confirmShopOrderPaymentViaSms) is
 * tapped -- same two-stage read shape as [SupportDeepLink]:
 *
 *  - MainActivity.onCreate()/onNewIntent() sets [pendingOrderId] from the
 *    tapped notification's Intent extra (cold vs. warm start).
 *  - AgentApp()'s top-level composable observes it just enough to force
 *    `screen = Screen.HOME` if elsewhere; AgentHome (only composed once
 *    actually on Home) does the real work -- clears the flag, fetches the
 *    order via GET /agent/shop-orders/{id}, and navigates to
 *    Screen.SHOP_ORDER_DETAIL.
 *
 * Unlike Support (at most one assigned conversation, so a bare boolean is
 * enough), a Shop payment push is about one specific order among many, so
 * this carries the order id itself rather than just a flag.
 */
object ShopOrderDeepLink {
    var pendingOrderId: String? by mutableStateOf(null)
}
