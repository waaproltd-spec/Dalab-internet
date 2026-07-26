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
)

data class Transaction(
    val orderId: String,
    val customerName: String,
    val company: String,
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
