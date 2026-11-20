package com.dalab.internet.data

import com.google.gson.annotations.SerializedName

/**
 * Mirrors `exchange_orders` as returned by admin-backend-ts's
 * EXCHANGE_ORDER_LIST_SELECT (src/routes/exchange.routes.ts), camelCased by
 * the server's sendJson helper. Money Exchange is a completely separate
 * business line from Internet Store's `Order` above — settlement, USSD
 * flow, and this model are all independent.
 */
data class ExchangeOrder(
    val id: String,               // "DEX..." reference
    val customerId: String? = null,
    val customerPhone: String? = null,
    val customerName: String? = null,
    val corridorId: String,
    val fromWalletId: String,
    val toWalletId: String,
    val fromWalletName: String? = null,
    val toWalletName: String? = null,
    val amountSent: Double,
    val rateApplied: Double? = null,
    val feeApplied: Double? = null,
    val amountReceived: Double,
    val senderPhone: String,
    val receiverPhone: String,
    val status: ExchangeOrderStatus,
    val agentId: String? = null,
    val agentName: String? = null,
    val channel: String? = null,
    val createdAt: String,
    val completedAt: String? = null,
    // Only present on GET /agent/exchange/orders (the automatic payout
    // queue) — true the moment ANY dial attempt exists for this order
    // (success, failure, or ambiguous), regardless of which device made
    // it. ExchangeSelfHealSweeper checks this before calling
    // executePayout() so a failed/ambiguous automated attempt is never
    // retried automatically — it stays Failed for a human to act on
    // (manual payout in ExchangeOrderDetailScreen), never silently redialed.
    val hasDialAttempt: Boolean = false,
)

enum class ExchangeOrderStatus {
    @SerializedName("pending") PENDING,
    @SerializedName("in_progress") IN_PROGRESS,
    @SerializedName("completed") COMPLETED,
    @SerializedName("failed") FAILED,
    @SerializedName("cancelled") CANCELLED,
}
