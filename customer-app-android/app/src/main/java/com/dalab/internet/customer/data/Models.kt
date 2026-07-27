package com.dalab.internet.customer.data

import com.google.gson.annotations.SerializedName

/** Mirrors the customer object returned by OTP verify / GET /customer/profile. */
data class CustomerProfile(
    val id: String,
    val phone: String,
    val name: String?,
    val macaashPoints: Int = 0,
)

/** Mirrors GET /promo-images (admin-backend-ts, promoImages.routes.ts) — public, Super Admin-uploaded only. */
data class PromoImage(
    val id: String,
    val position: Int,
)

/** Mirrors GET /companies (admin-backend-ts, companies.routes.ts) — public, no auth required. */
data class Company(
    val id: String,
    val name: String,
    val groupNumber: Int,
    val colorHex: String,
    val logoUrl: String? = null,
    val status: String, // "online" | "offline"
    val gateway: String? = null,
    // The agent/company's own payment number and full deposit USSD code
    // (e.g. "*712*610338686*{amount}#") — the customer dials this exact
    // number to pay the agent/company, never their own phone number.
    val paymentNumber: String? = null,
    val paymentUssdTemplate: String? = null,
)

/** Mirrors GET /companies/{id}/packages. */
data class PackageItem(
    val id: String,
    val companyId: String,
    val categoryId: String,
    val name: String,
    val oldPrice: Double? = null,
    val price: Double,
    val mb: Int = 0,
    val minutes: Int = 0,
    val sms: Int = 0,
    val validity: String? = null,
    val active: Boolean = true,
)

enum class OrderStatus {
    @SerializedName("pending") PENDING,
    @SerializedName("in_progress") IN_PROGRESS,
    @SerializedName("completed") COMPLETED,
    @SerializedName("failed") FAILED,
    @SerializedName("cancelled") CANCELLED,
}

/** Mirrors GET /orders and POST /orders (customer-scoped) — orders.routes.ts. */
data class CustomerOrder(
    val id: String,
    val companyId: String,
    val companyName: String,
    val packageId: String,
    val packageName: String,
    val amount: Double,
    val status: OrderStatus,
    val senderPhone: String?,
    val receiverPhone: String?,
    val paymentMethod: String?,
    val macaashEarned: Int = 0,
    val ussdGenerated: String? = null,
    val createdAt: String,
    val completedAt: String? = null,
)

data class MacaashBalance(val balance: Int)

/** Mirrors GET /macaash/rewards — a static rewards catalog. */
data class MacaashReward(
    val id: String,
    val title: String,
    val cost: Int,
)

/** Mirrors GET /macaash/history — one row from macaash_transactions. */
data class MacaashHistoryEntry(
    val id: String,
    val points: Int,
    val reason: String?,
    val createdAt: String,
)
