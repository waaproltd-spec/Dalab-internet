package com.dalab.internet.customer.data

import com.google.gson.annotations.SerializedName

/** Mirrors the customer object returned by OTP verify / GET /customer/profile. */
data class CustomerProfile(
    val id: String,
    val phone: String,
    val name: String?,
)

/** Mirrors GET /promo-images (admin-backend-ts, promoImages.routes.ts) — public, Super Admin-uploaded only. */
data class PromoImage(
    val id: String,
    val position: Int,
)

/** Mirrors GET /notifications (admin-backend-ts, notifications.routes.ts) — customer-scoped, excludes 'maintenance' type. */
data class NotificationItem(
    val id: String,
    val type: String,
    val title: String,
    val body: String?,
    val sentAt: String,
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

/**
 * Mirrors GET /payment-wallets (public) — the wallet list shown in "Select
 * Payment Method", Super-Admin managed. companyId/paymentNumber are THIS
 * wallet's own provider — server-joined from payment_wallets.company_id,
 * never the purchased package's company. Paying via one telecom's wallet to
 * buy a different telecom's package is intentional; never conflate the two.
 */
data class PaymentWallet(
    val id: String,
    val name: String,
    val providerLabel: String? = null,
    val companyId: String? = null,
    val dialPrefix: String,
    val logoKey: String,
    val colorHex: String,
    val enabled: Boolean = true,
    val sortOrder: Int = 0,
    val paymentNumber: String? = null,
)

/**
 * Mirrors GET /companies/{id}/categories — the Super-Admin-configured
 * display name for a category, keyed by `slug` (which is what
 * PackageItem.categoryId actually matches; category_id is free text, not a
 * foreign key, so this is a client-side lookup, not a guaranteed join).
 */
data class ServiceCategory(
    val id: String,
    val companyId: String,
    val slug: String,
    val name: String,
    val status: String,
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
    val ussdGenerated: String? = null,
    val createdAt: String,
    val completedAt: String? = null,
    // Schedule Recharge fields — all null for the vast majority of orders
    // (never scheduled). scheduledAt: when fulfillment is deferred until.
    // cancellationRequestedAt: customer asked to cancel a still-pending
    // schedule. cancellationDecision: null while awaiting Super Admin
    // review, else "approved" (order was cancelled/reversed) or "rejected"
    // (recharge proceeds as originally scheduled).
    val scheduledAt: String? = null,
    val cancellationRequestedAt: String? = null,
    val cancellationDecision: String? = null,
)
