package com.dalab.internet.data

import com.google.gson.annotations.SerializedName

/**
 * Mirrors the `orders` table exactly as the production backend returns it
 * (dalab-admin-backend-ts, src/routes/orders.routes.ts — Express + TypeScript
 * + PostgreSQL, the sole production backend for this project as of the
 * backend consolidation; response shapes are verified identical to the
 * earlier SQLite backend this was originally built against, field-by-field).
 * An earlier version of this file had its OrderStatus enum stale against the
 * real backend (used PENDING/VERIFIED/COMPLETED instead of the actual
 * pending/in_progress/completed/failed/cancelled) — Gson would have thrown a
 * deserialization error on every single order fetch. @SerializedName below
 * maps each constant to the exact lowercase/underscore value the server
 * actually sends.
 */
data class Order(
    val id: String,               // "DLB..." reference
    val customerName: String?,
    val customerPhone: String?,
    val companyId: String,        // "hormuud" | "somnet" | "somtel" | "amtel" — needed to look up SIM routing
    val companyName: String,
    val packageName: String,
    val amount: Double,
    val status: OrderStatus,
    val senderPhone: String?,
    val receiverPhone: String?,
    val paymentMethod: String?,
    val macaashEarned: Int = 0,
    val ussdGenerated: String? = null,
    // Set when the matched USSD template pins this order to a specific
    // device+SIM slot (Admin > USSD Templates); null means "use this
    // device's normal per-company sim_routing entry" (SimRoutingRepository).
    val ussdDeviceId: String? = null,
    val ussdSimSlot: Int? = null,
    val createdAt: String,
    val completedAt: String? = null,
)

enum class OrderStatus {
    @SerializedName("pending") PENDING,
    @SerializedName("in_progress") IN_PROGRESS,
    @SerializedName("completed") COMPLETED,
    @SerializedName("failed") FAILED,
    @SerializedName("cancelled") CANCELLED,
}

/**
 * One row from `sms_logs` — either freshly captured by this device's listener, or
 * fetched from the server for review.
 */
data class SmsLogEntry(
    val id: String? = null,       // null until the server assigns one
    val sender: String,
    val body: String,
    val parsedProvider: String? = null,
    val parsedAmount: Double? = null,
    val parsedPhone: String? = null,
    val matchedOrderId: String? = null,
    val receivedAt: String,
    // The telecom's own per-transaction reference/receipt code, when the SMS
    // format includes one (e.g. Somtel eDahab's "Aqanoosiga" field) — a
    // stronger duplicate-payment signal than sender+body+timestamp alone.
    // Null for formats with no such field; the server falls back to its
    // existing sender+body+minute dedup in that case.
    val transactionRef: String? = null,
)

data class Transaction(
    val orderId: String,
    val customerName: String,
    val companyName: String,
    val amount: Double,
    val completedAt: String,
)

data class AgentProfile(
    val id: String,
    val name: String,
    val phone: String,
)

data class AgentNotification(
    val id: String,
    val title: String,
    val body: String,
    val receivedAt: String,
    val read: Boolean = false,
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

/** Mirrors GET/POST /agent/customers — a lighter view than the admin customer record. */
data class CustomerSummary(
    val id: String,
    val phone: String,
    val name: String?,
    val status: String, // "active" | "blocked"
    val macaashPoints: Int = 0,
    val createdAt: String,
)

/** One day's worth of an agent's completed sales, from GET /agent/reports. */
data class ReportPoint(
    val day: String,
    val sales: Double,
    val orders: Int,
)

data class ReportTotals(
    val totalSales: Double,
    val totalOrders: Int,
)

data class AgentReport(
    val range: String,
    val series: List<ReportPoint>,
    val totals: ReportTotals,
)

/** Mirrors GET /agent/devices — the physical Agent App installs registered under this account. */
data class AgentDevice(
    val id: String,
    val name: String,
    val description: String? = null,
)
