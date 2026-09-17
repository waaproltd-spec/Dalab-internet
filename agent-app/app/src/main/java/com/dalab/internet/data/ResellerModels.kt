package com.dalab.internet.data

/**
 * The Agent App's window into the EXISTING Admin Reseller system
 * (admin-backend-ts: resellers.routes.ts, resellerOrders.routes.ts,
 * resellerDepositsWithdrawals.routes.ts, resellerPaymentConfig.routes.ts —
 * migrations 048-060). Every field here mirrors that backend's own
 * camelCased JSON response exactly (see admin-backend-ts's
 * utils/camelCase.ts) — nothing here is a new/duplicate reseller model,
 * it's the same `resellers`/`reseller_wallets`/`reseller_orders`/
 * `reseller_deposits`/`reseller_withdrawals` rows Admin already reads and
 * writes, just consumed here under a reseller-role login instead of an
 * admin one. A reseller logging in here is a distinct identity/session
 * from the Agent App's own agent-device login (role "reseller" vs role
 * "agent" JWTs) — see auth/ResellerSessionManager.kt and
 * network/ResellerApiClient.kt for why they're kept completely separate.
 */

/** The `reseller` object POST /reseller/auth/login returns alongside its tokens. */
data class ResellerProfile(
    val id: String,
    val resellerLoginId: String,
    val name: String,
    val walletBalance: Double,
)

data class ResellerLoginResponse(
    val accessToken: String,
    val refreshToken: String,
    val reseller: ResellerProfile,
)

/** Mirrors GET /reseller/me. */
data class ResellerMe(
    val id: String,
    val resellerLoginId: String,
    val name: String,
    val status: String, // "active" | "suspended"
    val walletBalance: Double,
)

/** Mirrors GET /reseller/companies -- every online company, this reseller's
 * current per-company recharge rate (null if Admin hasn't configured one
 * yet -- that company just isn't orderable), and the withdrawal commission
 * % Admin has configured for it. */
data class ResellerCompany(
    val id: String,
    val name: String,
    val colorHex: String?,
    val logoUrl: String?,
    val hasLogo: Boolean,
    val rate: Double?,
    val withdrawCommissionPercentage: Double,
)

/** Mirrors GET /reseller/payment-numbers?companyId=&role=. */
data class ResellerPaymentNumber(
    val id: String,
    val companyId: String,
    val role: String, // "sending" | "receiving"
    val paymentNumber: String,
    val label: String?,
)

/** Mirrors GET /reseller/deposit-methods -- Dalab's own EVC/eDahab
 * collection numbers a reseller sends a deposit to. */
data class ResellerDepositMethod(
    val method: String, // "evc" | "edahab"
    val label: String,
    val paymentNumber: String,
    val ussdTemplate: String,
)

/** A `reseller_orders` row -- the reseller's own recharge-order pipeline,
 * separate from (not a reseller_id tag on) the normal customer `orders`
 * table. receivingNumber is the end customer's number this order topped
 * up -- the closest thing this system has to "which customers use this
 * reseller account" (there's no separate customer-link table). */
data class ResellerOrder(
    val id: String,
    val companyId: String,
    val companyName: String,
    val companyColor: String?,
    val receivingNumber: String,
    val amount: Double,
    val rateApplied: Double,
    val amountCalculated: Double,
    val status: String, // pending | payment_sent | confirmed | completed | cancelled | failed
    val createdAt: String,
    val paymentSentAt: String?,
    val confirmedAt: String?,
    val completedAt: String?,
    val cancelledAt: String?,
)

/** A `reseller_deposits` row -- "Lacag Ku Shub", the reseller topping up
 * their own wallet. Does not credit the wallet until Admin verifies it. */
data class ResellerDeposit(
    val id: String,
    val method: String,
    val methodLabel: String,
    val toNumber: String,
    val fromNumber: String,
    val amount: Double,
    val status: String, // pending | verified | completed | failed
    val createdAt: String,
    val verifiedAt: String?,
    val completedAt: String?,
)

/** A `reseller_withdrawals` row -- "Lacag Bixi", cashing out. Same table
 * the Agent App's existing ussd/ResellerWithdrawalUssdOrchestrator.kt
 * already completes on the payout-dial side; payoutUssdTemplate is always
 * masked out for a reseller login (never leaks a PIN-inlined dial string
 * to a non-agent identity -- see resellerDepositsWithdrawals.routes.ts's
 * maskWithdrawalForReseller()), so it's simply not modeled here. */
data class ResellerWithdrawal(
    val id: String,
    val companyId: String,
    val companyName: String,
    val companyColor: String?,
    val destinationNumber: String,
    val amount: Double,
    val status: String, // reserved | sent | completed | cancelled | failed
    val commissionPercentage: Double,
    val bonusAmount: Double,
    val customerReceivesAmount: Double,
    val createdAt: String,
    val sentAt: String?,
    val completedAt: String?,
    val cancelledAt: String?,
)
