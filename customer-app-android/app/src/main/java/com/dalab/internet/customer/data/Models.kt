package com.dalab.internet.customer.data

import com.google.gson.annotations.SerializedName

/** Mirrors the customer object returned by OTP verify / GET /customer/profile.
 * photoBase64 is a full "data:<mime>;base64,<data>" string (or null if the
 * customer has no photo set) — the same shape uploaded to PUT
 * /customer/profile/photo, never persisted to SessionManager (only ever
 * held in this screen's own Compose state — see ProfileScreen). */
data class CustomerProfile(
    val id: String,
    val phone: String,
    val name: String?,
    val photoBase64: String? = null,
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
)

// ==================== Money Exchange — a separate main service from ====================
// ==================== Internet Store, never mixed with CustomerOrder ====================

/** Mirrors GET /exchange/wallets (public) — exchange.routes.ts. */
data class ExchangeWallet(
    val id: String,
    val name: String,
    val providerLabel: String? = null,
    val colorHex: String,
    val logoKey: String,
    val dialPrefix: String,
)

/** Mirrors GET /exchange/corridors (public) — a From-wallet -> To-wallet pair
 * with its own rate/fee, e.g. "eDahab -> EVC Plus". Selecting a corridor IS
 * selecting both the From and To wallet at once — there's no independent
 * wallet picker, since not every pair is a valid/enabled corridor. */
data class ExchangeCorridor(
    val id: String,
    val fromWalletId: String,
    val toWalletId: String,
    val fromWalletName: String? = null,
    val toWalletName: String? = null,
    val rate: Double,
    val feeType: String, // "fixed" | "percentage"
    val feeValue: Double,
    val minAmount: Double? = null,
    val maxAmount: Double? = null,
    val enabled: Boolean = true,
)

/** Mirrors GET /exchange/quote — a live preview, never trusted for the
 * actual order (the backend recomputes amountReceived server-side too). */
data class ExchangeQuote(
    val corridorId: String,
    val amountSent: Double,
    val rate: Double,
    val fee: Double,
    val amountReceived: Double,
)

data class CreateExchangeOrderRequest(
    val corridorId: String,
    val amount: Double,
    val senderPhone: String,
    val receiverPhone: String,
    val clientRequestId: String? = null,
)

enum class ExchangeOrderStatus {
    @SerializedName("pending") PENDING,
    @SerializedName("in_progress") IN_PROGRESS,
    @SerializedName("completed") COMPLETED,
    @SerializedName("failed") FAILED,
    @SerializedName("cancelled") CANCELLED,
}

/**
 * Mirrors GET/POST /exchange/orders (customer-scoped) — exchange.routes.ts.
 * Two customer-facing stages only (per the app's own flow, not a literal
 * mirror of every backend status): "Pay Now" while PENDING, "Confirmation"
 * for everything else the order has definitively reached (IN_PROGRESS —
 * payment verified, payout under way — reads the same as COMPLETED to the
 * customer: their payment went through) — see [ExchangeStatusScreen].
 * receiverPhone is the RECIPIENT's wallet number, never the customer's own
 * account — it is only ever used for this one transaction, never saved as
 * "my number" anywhere in this app.
 */
data class ExchangeOrder(
    val id: String,
    val corridorId: String,
    val fromWalletId: String,
    val toWalletId: String,
    val fromWalletName: String? = null,
    val toWalletName: String? = null,
    val amountSent: Double,
    val rateApplied: Double,
    val feeApplied: Double,
    val amountReceived: Double,
    val senderPhone: String,
    val receiverPhone: String,
    val status: ExchangeOrderStatus,
    val collectionPhoneNumber: String? = null,
    val payoutStarted: Boolean = false,
    val createdAt: String,
    val completedAt: String? = null,
)

/** The exact, backend-validated category enum for POST /feedback
 * (feedback.routes.ts FEEDBACK_CATEGORIES) — the "Select Issue" sheet on
 * [FeedbackScreen] offers exactly these seven, once each. */
enum class FeedbackCategory(val apiValue: String, val label: String, val labelSo: String) {
    APP_CRASHES("App Crashes Frequently", "App Crashes Frequently", "App-ku si joogto ah ayuu u xiraa"),
    PAYMENT_FAILED("Unable to Complete Payment", "Unable to Complete Payment", "Lacag-bixinta lama dhamaystirin"),
    INTERNET_PACKAGE("Internet Package Problem", "Internet Package Problem", "Dhibaato ku saabsan baakada Internetka"),
    PAYMENT_VERIFICATION("Payment Verification Issue", "Payment Verification Issue", "Dhibaato xaqiijinta lacag-bixinta"),
    MAKE_SUGGESTION("Make Suggestion", "Make Suggestion", "Soo Jeedin"),
    FEEDBACK("Feedback", "Feedback", "Fikrad"),
    OTHER("Other", "Other", "Kale"),
}

/** Body for POST /feedback (feedback.routes.ts). */
data class FeedbackRequest(val category: String, val message: String, val deviceInfo: String? = null)

data class FeedbackResponse(val id: String, val category: String, val message: String, val status: String)
