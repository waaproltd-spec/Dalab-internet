package com.dalab.internet.data

/**
 * Shop, VIP Number, and VIP Number Package orders as seen by an agent --
 * mirrors admin-backend-ts's own agent-scoped routes exactly:
 * GET agent/shop/orders(/{id}), GET agent/vip-numbers/orders(/{id}),
 * GET agent/vip-numbers/packages/orders(/{id}). Deliberately separate
 * data classes from Order (agent/orders -- the Internet Store recharge
 * queue) rather than reusing it, same "own model per business line"
 * convention ExchangeModels.kt/ResellerWithdrawalModels.kt already
 * follow -- these are unrelated products with unrelated status
 * vocabularies. status/paymentStatus are kept as plain String (not a
 * SerializedName enum like OrderStatus) since these screens only display
 * them and gate on a couple of specific string values -- no exhaustive
 * `when` needs to compile-fail if the backend ever adds a new one.
 *
 * NUMERIC columns (price/totalAmount/etc.) come back from pg as decimal
 * strings, not JSON numbers -- kept as String here and parsed with
 * toDoubleOrNull() only at display time, matching how every other price
 * field already flows through this app's models.
 */

data class ShopAgentOrder(
    val id: String,
    val customerName: String? = null,
    val customerPhone: String? = null,
    val deliveryName: String? = null,
    val deliveryPhone: String? = null,
    val deliveryAddress: String? = null,
    val paymentMethod: String? = null,
    val senderPhone: String? = null,
    val totalAmount: String? = null,
    val deliveryFee: String? = null,
    val paymentStatus: String? = null,
    // "pending" | "processing" | "shipped" | "delivered" | "cancelled" |
    // "failed" | "returned" | "refunded" -- Shop has no separate literal
    // "completed" status; "delivered" IS the completed/terminal state, same
    // as admin-backend-ts's SHOP_ORDER_STATUSES/TERMINAL_SHOP_STATUSES.
    val status: String? = null,
    val trackingReference: String? = null,
    val courierName: String? = null,
    val createdAt: String? = null,
    val items: List<ShopAgentOrderItem>? = null,
) {
    val isPaid: Boolean get() = paymentStatus == "paid"
    val isTerminal: Boolean get() = status in TERMINAL_SHOP_STATUSES
    /** Matches POST agent/shop/orders/{id}/complete's own server-side guard
     * exactly -- must be paid and not already terminal. */
    val canComplete: Boolean get() = isPaid && !isTerminal
}

private val TERMINAL_SHOP_STATUSES = setOf("delivered", "cancelled", "failed", "returned", "refunded")

data class ShopAgentOrderItem(
    val productName: String? = null,
    val unitPrice: String? = null,
    val quantity: Int? = null,
    val subtotal: String? = null,
)

/** completed_at/cancelled_at exist server-side too, not modeled here --
 * this screen only ever needs createdAt for "Order date/time" per the
 * spec, and current status for the Complete Order gate. */
data class VipNumberAgentOrder(
    val id: String,
    val vipNumberId: String? = null,
    val phoneNumber: String? = null,
    val category: String? = null, // "gold" | "silver"
    val companyName: String? = null,
    val price: String? = null,
    val customerFullName: String? = null,
    val customerName: String? = null,
    val customerPhone: String? = null,
    val location: String? = null,
    val district: String? = null,
    val motherName: String? = null,
    val paymentMethod: String? = null,
    val senderPhone: String? = null,
    val paymentStatus: String? = null, // "pending" | "paid"
    val status: String? = null, // "pending" | "processing" | "completed" | "cancelled" | "failed" | "expired"
    val createdAt: String? = null,
) {
    val isPaid: Boolean get() = paymentStatus == "paid"
    val isTerminal: Boolean get() = status in TERMINAL_VIP_STATUSES
    /** Matches POST agent/vip-numbers/orders/{id}/complete's own
     * server-side guard exactly -- must be paid and not already terminal. */
    val canComplete: Boolean get() = isPaid && !isTerminal
}

data class VipPackageAgentOrder(
    val id: String,
    val packageId: String? = null,
    val size: Int? = null,
    val price: String? = null,
    val customerFullName: String? = null,
    val customerName: String? = null,
    val customerPhone: String? = null,
    val location: String? = null,
    val district: String? = null,
    val motherName: String? = null,
    val paymentMethod: String? = null,
    val senderPhone: String? = null,
    val paymentStatus: String? = null,
    val status: String? = null,
    val createdAt: String? = null,
    val items: List<VipPackageAgentOrderItem>? = null,
) {
    val isPaid: Boolean get() = paymentStatus == "paid"
    val isTerminal: Boolean get() = status in TERMINAL_VIP_STATUSES
    /** Matches POST agent/vip-numbers/packages/orders/{id}/complete's own
     * server-side guard exactly. */
    val canComplete: Boolean get() = isPaid && !isTerminal
}

data class VipPackageAgentOrderItem(
    val vipNumberId: String? = null,
    val phoneNumber: String? = null,
    val category: String? = null,
    val companyId: String? = null,
    val companyName: String? = null,
)

private val TERMINAL_VIP_STATUSES = setOf("completed", "cancelled", "failed", "expired")
