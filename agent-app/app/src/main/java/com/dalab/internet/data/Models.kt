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
    // Which physical SIM slot (1 or 2 — matches ussd_templates.sim_slot's
    // existing 1-based convention) on THIS device actually received the
    // SMS, resolved from the incoming broadcast's subscription id (see
    // SmsReceiver.resolveSimSlot). Null when it can't be determined
    // (single-SIM device, missing READ_PHONE_STATE, older/OEM broadcast
    // with no subscription extra) — the backend then falls back to
    // device-level matching only.
    val simSlot: Int? = null,
)

data class Transaction(
    val orderId: String,
    // Nullable despite the backend now coalescing to phone as a fallback —
    // customers.name is nullable in the database, and a non-null Kotlin
    // field here previously crashed the app the moment Gson silently
    // assigned null to it for a customer with no name on file.
    val customerName: String? = null,
    val companyName: String,
    val amount: Double,
    val completedAt: String,
)

/** GET /agent/wallet-balances — one row per SIM slot (1 and 2) on this
 * agent's own device, regardless of whether a real balance has been
 * recorded yet (providerName/phoneNumber/balance are null/0 until the
 * first real payment SMS or a manual override sets them). */
data class WalletBalanceEntry(
    val simSlot: Int,
    val companyId: String? = null,
    val providerName: String? = null,
    val colorHex: String? = null,
    val phoneNumber: String? = null,
    val balance: Double = 0.0,
    val lowBalanceThreshold: Double = 5.0,
    val balanceUpdatedAt: String? = null,
)

/** GET /agent/payment-transactions — every payment_transactions row this
 * agent's own SMS uploads produced, matched or not, dialed or not. */
data class AgentPaymentTransaction(
    val id: String,
    val orderId: String? = null,
    val customerPhone: String? = null,
    val amount: Double? = null,
    // "pending" | "processing" | "completed" | "failed" | "duplicate_blocked"
    val status: String,
    val createdAt: String,
    val smsSender: String? = null,
    val providerName: String? = null,
)

data class AgentProfile(
    val id: String,
    val name: String,
    val phone: String,
)

/**
 * Mirrors GET /agent/notifications (notifications.routes.ts) — admin-sent
 * system notices, camelCased from the `notifications` table's sent_at
 * column. There is no per-agent read state server-side; "unread" is tracked
 * locally, see AgentAlertsState.
 */
data class AgentNotification(
    val id: String,
    val title: String,
    val body: String,
    val sentAt: String,
)

// ---------------- Agent Support (support.routes.ts, /agent/support/*) ----------------
// Same support_conversations/support_messages rows the Admin Dashboard's
// "Agent Support" panel already reads and writes (super-admin-app/src/App.jsx)
// — a field agent claiming, chatting in, and resolving/closing a conversation
// here is indistinguishable server-side from a staff member doing the same
// thing from the dashboard. See serializeConversation() in support.routes.ts
// for the exact shape; the queue-listing endpoint returns a subset (no
// queuePosition/customersAhead/agentName/messages), hence all of those being
// nullable/defaulted here rather than required.

enum class SupportConversationStatus {
    @SerializedName("queued") QUEUED,
    @SerializedName("pending") PENDING,
    @SerializedName("assigned") ASSIGNED,
    @SerializedName("resolved") RESOLVED,
    @SerializedName("closed") CLOSED,
}

data class SupportMessage(
    val id: String,
    // "customer" | "agent" | "system"
    val senderType: String,
    // "text" | "image" | "voice" -- see support.routes.ts's composeMessage.
    val messageType: String = "text",
    val body: String? = null,
    // Path (not a full URL), e.g. "/support/messages/{id}/media" -- resolve
    // against ApiClient.BASE_URL and attach the same bearer token as every
    // other call. Non-null only for image/voice messages.
    val mediaUrl: String? = null,
    val mediaMimeType: String? = null,
    val createdAt: String? = null,
)

data class SupportConversation(
    val id: String,
    val customerId: String? = null,
    val topic: String,
    val status: SupportConversationStatus,
    val agentId: String? = null,
    val agentRole: String? = null,
    val agentOfflineAtStart: Boolean = false,
    val queuePosition: Int? = null,
    val customersAhead: Int? = null,
    val agentName: String? = null,
    val customerName: String? = null,
    val customerPhone: String? = null,
    val firstMessage: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val assignedAt: String? = null,
    val resolvedAt: String? = null,
    val closedAt: String? = null,
    val messages: List<SupportMessage> = emptyList(),
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
