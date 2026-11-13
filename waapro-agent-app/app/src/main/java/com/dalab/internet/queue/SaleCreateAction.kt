package com.dalab.internet.queue

import com.dalab.internet.network.CreateSaleRequest

/**
 * Payload for a [PendingActionQueue.Type.SALE_CREATE] entry — an
 * agent-initiated sale (NewSaleScreen) that couldn't reach the backend
 * because the device was offline. [request]'s own clientRequestId is what
 * makes a later retry safe: POST /agent/orders already dedups on that field
 * server-side, so replaying this exact request after reconnecting can never
 * create two orders for one sale. [packageName] is display-only, so a
 * "pending sales" list can show something readable without re-fetching.
 */
data class SaleCreateAction(val request: CreateSaleRequest, val packageName: String)
