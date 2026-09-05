package com.dalab.internet.network

import com.dalab.internet.data.AgentDevice
import com.dalab.internet.data.AgentProfile
import com.dalab.internet.data.AgentReport
import com.dalab.internet.data.Company
import com.dalab.internet.data.CustomerSummary
import com.dalab.internet.data.ExchangeOrder
import com.dalab.internet.data.Order
import com.dalab.internet.data.PackageItem
import com.dalab.internet.data.ResellerWithdrawalPendingPayout
import com.dalab.internet.data.ResellerWithdrawalSimRoutingEntry
import com.dalab.internet.data.ShopAgentOrder
import com.dalab.internet.data.SmsLogEntry
import com.dalab.internet.data.SupportConversation
import com.dalab.internet.data.Transaction
import com.dalab.internet.data.AgentNotification
import com.dalab.internet.data.AgentPaymentTransaction
import com.dalab.internet.data.VipNumberAgentOrder
import com.dalab.internet.data.VipPackageAgentOrder
import com.dalab.internet.data.WalletBalanceEntry
import com.dalab.internet.sms.SmsSenderIdEntry
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.*

data class DeviceLoginRequest(val deviceId: String)
data class DiagnosticsEntryDto(
    val tag: String,
    val message: String,
    val isError: Boolean,
    val occurredAt: Long,
)
data class HeartbeatRequest(
    val batteryPercent: Int?,
    val networkOnline: Boolean,
    val sim1Present: Boolean?,
    val sim2Present: Boolean?,
    // Reliability Dashboard: piggybacks the device's not-yet-delivered local
    // DiagnosticsLog entries onto this same call rather than a separate
    // endpoint/round-trip — best-effort, omitted (null/empty) when there's
    // nothing new to report.
    val recentDiagnostics: List<DiagnosticsEntryDto>? = null,
)
data class LoginResponse(val accessToken: String, val refreshToken: String, val agent: AgentProfile)
data class RegisterDeviceTokenRequest(val fcmToken: String)
data class RefreshRequest(val refreshToken: String)
data class RefreshResponse(val accessToken: String, val refreshToken: String)
data class VerifyPaymentRequest(val smsLogId: String? = null)
data class SmsLogUploadResponse(
    val id: String,
    val matchedOrderId: String?,
    val requiresManualApproval: Boolean = false,
    // See admin-backend-ts smsLogs.routes.ts: duplicate/status reflect the
    // server's transaction_ref (or sender+body+minute) dedup check — a
    // duplicate payment is rejected as "already_processed" rather than
    // being matched/dialed a second time.
    val duplicate: Boolean = false,
    val status: String? = null,
    val orderAlreadyCompleted: Boolean = false,
)
data class VoucherConfirmationRequest(val receiverPhone: String, val amount: Double, val provider: String)
data class VoucherConfirmationResponse(val matched: Boolean, val orderId: String? = null, val alreadyCompleted: Boolean = false)
data class ExchangePayoutConfirmationRequest(val receiverPhone: String, val amount: Double, val rawText: String)
data class ExchangePayoutConfirmationResponse(val matched: Boolean, val orderId: String? = null, val alreadyCompleted: Boolean = false)

// ---------------- Notification broadcast ----------------
// Same POST /notifications/broadcast + GET /notifications/campaigns the
// Admin dashboard's Notifications tab uses (App.jsx's DalabAdminApi.
// broadcastNotification/getNotificationCampaigns) — an agent hitting these
// exact routes gets the identical targeting options and history the Admin
// dashboard shows, with no capability gap between the two apps.
data class BroadcastRequest(
    val targetType: String, // "single" | "multiple" | "all" | "recent"
    val customerIds: List<String> = emptyList(),
    val serviceFilter: String, // "all" | "internet" | "ebadal" | "reseller"
    val title: String,
    val body: String,
)
data class BroadcastResponse(
    val id: String,
    val recipientCount: Int,
    val sentCount: Int,
    val deliveredCount: Int,
    val failedCount: Int,
)
data class NotificationCampaign(
    val id: String,
    val title: String,
    val body: String,
    val targetType: String,
    val serviceFilter: String,
    val recipientCount: Int,
    val sentCount: Int,
    val deliveredCount: Int,
    val failedCount: Int,
    val createdByName: String?,
    val createdByRole: String,
    val createdAt: String,
)
data class DialAttemptStartRequest(val simSlot: Int?, val ussdString: String, val attemptNumber: Int)
data class DialAttemptStartResponse(val id: String)
// isFinalAttempt: true when this is the last outcome this order will get
// (success, a non-retryable failure, or the last of maxAttempts retries) —
// the backend only marks the order 'failed' when this is true, so a
// mid-retry attempt reported as failed/ambiguous doesn't show the customer
// "Failed" moments before a later retry might still succeed.
data class DialAttemptResultRequest(val status: String, val responseMessage: String?, val isFinalAttempt: Boolean = true)
data class DialAttemptResultResponse(val id: String, val status: String)
// ---------------- Agent Support ----------------

data class SupportStatusResponse(val online: Boolean, val activeConversationId: String? = null)
data class SupportStatusUpdateRequest(val online: Boolean)
data class SupportClaimNextResponse(val claimed: SupportConversation? = null)
// messageType is "text" (default -- message required), "image", or "voice"
// (mediaBase64 required for the latter two -- a data:<mime>;base64,<data>
// string, see support.routes.ts's composeMessage).
data class SupportSendMessageRequest(
    val message: String? = null,
    val messageType: String = "text",
    val mediaBase64: String? = null,
)
data class SupportEndConversationResponse(val ended: Boolean, val next: SupportConversation? = null)

data class CreateCustomerRequest(val phone: String, val name: String? = null)
data class CreateSaleRequest(
    val customerPhone: String,
    val companyId: String,
    val packageId: String,
    val receiverPhone: String? = null,
    val paymentMethod: String? = null,
    val clientRequestId: String? = null,
)

// ---------------- Money Exchange (separate business line — see ussd/Exchange*.kt) ----------------

data class ExchangeDialAttemptStartRequest(val attemptNumber: Int = 1)
// pin is null only on the rare duplicate-insert path (a retried start call
// for an attemptNumber that already exists) — the caller must treat that as
// "can't proceed automatically, ask a Super Admin" rather than dial blind.
data class ExchangeDialAttemptStartResponse(val id: String, val step1UssdString: String, val pin: String? = null, val simSlot: Int? = null)
data class ExchangeStepRequest(val status: String, val responseMessage: String? = null, val isFinalAttempt: Boolean = true)
data class ExchangeDialAttemptDto(
    val id: String,
    val exchangeOrderId: String,
    val simSlot: Int? = null,
    val attemptNumber: Int,
    val step1UssdString: String? = null,
    val step1Response: String? = null,
    val step2Response: String? = null,
    val status: String,
    val createdAt: String,
    val completedAt: String? = null,
)

/**
 * Mirrors the backend architecture doc, §4 "Agent-facing", and the real
 * implementation in dalab-backend.zip (src/routes/ *.js) — every path and body
 * shape here matches what that server actually returns, verified against its
 * test suite. Base URL and auth header (Authorization: Bearer <token>) are
 * attached in ApiClient's OkHttp interceptor, not here — this interface only
 * describes the routes/shapes.
 */
interface ApiService {

    @POST("agent/auth/device-login")
    suspend fun deviceLogin(@Body body: DeviceLoginRequest): Response<LoginResponse>

    @POST("auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): Response<RefreshResponse>

    @GET("agent/orders")
    suspend fun getOrders(@Query("status") status: String? = null): Response<List<Order>>

    // Orders that reached in_progress with a USSD string generated but were
    // never actually dialed — e.g. generation failed at verify-payment time
    // and a Super Admin fixed the missing template/PIN afterward. Drained by
    // SelfHealSweeper so that fix alone is enough, with no manual "Dial Now"
    // tap required.
    @GET("agent/orders/self-heal-candidates")
    suspend fun getSelfHealCandidates(): Response<List<Order>>

    @GET("agent/orders/{id}")
    suspend fun getOrder(@Path("id") id: String): Response<Order>

    @POST("agent/orders/{id}/verify-payment")
    suspend fun verifyPayment(
        @Path("id") id: String,
        @Body body: VerifyPaymentRequest,
    ): Response<Order>

    @POST("agent/orders/{id}/complete")
    suspend fun completeOrder(@Path("id") id: String): Response<Order>

    // ---------------- Orders: Shop / VIP Numbers ----------------
    // Deliberately separate from agent/orders above (the Internet Store
    // recharge queue) -- same "own endpoints per business line" convention
    // as Money Exchange/Reseller Withdrawal. Real backend data only, no
    // agent-side order creation here: Shop/VIP orders are always
    // customer-initiated checkouts, never agent-created.

    @GET("agent/shop/orders")
    suspend fun getAgentShopOrders(@Query("status") status: String? = null): Response<List<ShopAgentOrder>>

    @GET("agent/shop/orders/{id}")
    suspend fun getAgentShopOrder(@Path("id") id: String): Response<ShopAgentOrder>

    // Real backend status change (pending/processing -> delivered) -- server
    // refuses with 409 unless payment_status is already 'paid' and the order
    // isn't already terminal (delivered/cancelled/failed/returned/refunded).
    // Never touches payment_status itself, so Paid stays Paid. Never
    // local-only, same as completeAgentVipNumberOrder below.
    @POST("agent/shop/orders/{id}/complete")
    suspend fun completeAgentShopOrder(@Path("id") id: String): Response<ShopAgentOrder>

    @GET("agent/vip-numbers/orders")
    suspend fun getAgentVipNumberOrders(@Query("status") status: String? = null): Response<List<VipNumberAgentOrder>>

    @GET("agent/vip-numbers/orders/{id}")
    suspend fun getAgentVipNumberOrder(@Path("id") id: String): Response<VipNumberAgentOrder>

    // Real backend status change (pending/processing -> completed) --
    // server refuses with 409 unless payment_status is already 'paid' and
    // the order isn't already terminal. Never local-only.
    @POST("agent/vip-numbers/orders/{id}/complete")
    suspend fun completeAgentVipNumberOrder(@Path("id") id: String): Response<VipNumberAgentOrder>

    @GET("agent/vip-numbers/packages/orders")
    suspend fun getAgentVipPackageOrders(@Query("status") status: String? = null): Response<List<VipPackageAgentOrder>>

    @GET("agent/vip-numbers/packages/orders/{id}")
    suspend fun getAgentVipPackageOrder(@Path("id") id: String): Response<VipPackageAgentOrder>

    @POST("agent/vip-numbers/packages/orders/{id}/complete")
    suspend fun completeAgentVipPackageOrder(@Path("id") id: String): Response<VipPackageAgentOrder>

    @GET("agent/transactions")
    suspend fun getTransactions(@Query("range") range: String? = null): Response<List<Transaction>>

    // ---------------- Wallet Balances dashboard ----------------

    @GET("agent/wallet-balances")
    suspend fun getWalletBalances(): Response<List<WalletBalanceEntry>>

    @GET("agent/payment-transactions")
    suspend fun getAgentPaymentTransactions(@Query("limit") limit: Int? = null): Response<List<AgentPaymentTransaction>>

    @POST("agent/sms-logs")
    suspend fun uploadSmsLog(@Body body: SmsLogEntry): Response<SmsLogUploadResponse>

    @POST("agent/orders/voucher-confirmation")
    suspend fun reportVoucherConfirmation(@Body body: VoucherConfirmationRequest): Response<VoucherConfirmationResponse>

    @POST("agent/exchange/orders/payout-confirmation")
    suspend fun reportExchangePayoutConfirmation(@Body body: ExchangePayoutConfirmationRequest): Response<ExchangePayoutConfirmationResponse>

    @GET("agent/notifications")
    suspend fun getNotifications(): Response<List<AgentNotification>>

    @POST("notifications/broadcast")
    suspend fun broadcastNotification(@Body body: BroadcastRequest): Response<BroadcastResponse>

    @GET("notifications/campaigns")
    suspend fun getNotificationCampaigns(): Response<List<NotificationCampaign>>

    // Registers/clears this device's FCM token so a newly-assigned support
    // conversation can push straight to it -- see notifications/
    // AgentFcmService.kt and PushTokenRegistrar.kt.
    @POST("agent/notifications/register-device")
    suspend fun registerAgentDeviceToken(@Body body: RegisterDeviceTokenRequest): Response<Unit>

    @POST("agent/notifications/unregister-device")
    suspend fun unregisterAgentDeviceToken(@Body body: RegisterDeviceTokenRequest): Response<Unit>

    // ---------------- Agent Support ----------------
    // Same routes the Admin Dashboard's "Agent Support" panel uses (registered
    // at both /admin/support/... and /agent/support/... by support.routes.ts's
    // dual() helper) — any online field agent may claim/handle a conversation,
    // same as any staff member with the support.manage permission.

    @GET("agent/support/status")
    suspend fun getSupportStatus(): Response<SupportStatusResponse>

    @PUT("agent/support/status")
    suspend fun setSupportStatus(@Body body: SupportStatusUpdateRequest): Response<SupportStatusResponse>

    @GET("agent/support/queue")
    suspend fun getSupportQueue(): Response<List<SupportConversation>>

    @GET("agent/support/conversations/{id}")
    suspend fun getSupportConversation(@Path("id") id: String): Response<SupportConversation>

    @POST("agent/support/claim-next")
    suspend fun claimNextSupportConversation(): Response<SupportClaimNextResponse>

    @POST("agent/support/conversations/{id}/claim")
    suspend fun claimSupportConversation(@Path("id") id: String): Response<SupportConversation>

    @POST("agent/support/conversations/{id}/messages")
    suspend fun sendSupportMessage(@Path("id") id: String, @Body body: SupportSendMessageRequest): Response<SupportConversation>

    // Note: registered at /support/messages/{id}/media (no /agent prefix) --
    // shared by the customer and any authorized staff/agent, see
    // support.routes.ts's combined auth check on that one route.
    @Streaming
    @GET("support/messages/{id}/media")
    suspend fun getSupportMessageMedia(@Path("id") id: String): Response<ResponseBody>

    @POST("agent/support/conversations/{id}/resolve")
    suspend fun resolveSupportConversation(@Path("id") id: String): Response<SupportEndConversationResponse>

    @POST("agent/support/conversations/{id}/close")
    suspend fun closeSupportConversation(@Path("id") id: String): Response<SupportEndConversationResponse>

    // Raw body, parsed manually and defensively in SimRoutingRepository —
    // see that class's comment for why: Retrofit's automatic
    // Response<List<SimRoutingEntry>> conversion throws (and previously
    // logged only an unhelpful "ClassCastException: no message") on this
    // exact device in production, with no way to see the actual payload
    // that failed to parse.
    @GET("agent/sim-routing")
    suspend fun getSimRoutingRaw(@Query("deviceId") deviceId: String? = null): Response<ResponseBody>

    @GET("agent/sms-sender-ids")
    suspend fun getSmsSenderIds(): Response<List<SmsSenderIdEntry>>

    @POST("agent/orders/{id}/dial-attempts")
    suspend fun startDialAttempt(@Path("id") orderId: String, @Body body: DialAttemptStartRequest): Response<DialAttemptStartResponse>

    @PUT("agent/dial-attempts/{attemptId}")
    suspend fun reportDialResult(@Path("attemptId") attemptId: String, @Body body: DialAttemptResultRequest): Response<DialAttemptResultResponse>

    // ---------------- Device identity & health (dual-mobile reliability) ----------------

    @GET("agent/devices")
    suspend fun getDevices(): Response<List<AgentDevice>>

    @POST("agent/devices/{id}/heartbeat")
    suspend fun sendHeartbeat(@Path("id") deviceId: String, @Body body: HeartbeatRequest): Response<Unit>

    // ---------------- Customer management (walk-in sales) ----------------

    @GET("agent/customers")
    suspend fun getCustomers(@Query("search") search: String? = null): Response<List<CustomerSummary>>

    @POST("agent/customers")
    suspend fun createCustomer(@Body body: CreateCustomerRequest): Response<CustomerSummary>

    // ---------------- Packages catalog (for sales + browsing) ----------------

    @GET("companies")
    suspend fun getCompanies(): Response<List<Company>>

    @GET("companies/{id}/packages")
    suspend fun getPackages(@Path("id") companyId: String): Response<List<PackageItem>>

    // ---------------- Sales ----------------

    @POST("agent/orders")
    suspend fun createSale(@Body body: CreateSaleRequest): Response<Order>

    // ---------------- Reports ----------------

    @GET("agent/reports")
    suspend fun getReports(@Query("range") range: String? = null): Response<AgentReport>

    // ---------------- Money Exchange ----------------
    // Deliberately separate endpoints/models from Internet Store's orders
    // above — see ExchangeUssdOrchestrator for why the USSD flow itself is
    // also a completely separate mechanism.

    @GET("agent/exchange/orders")
    suspend fun getExchangeOrders(): Response<List<ExchangeOrder>>

    @POST("agent/exchange/orders/{id}/dial-attempts")
    suspend fun startExchangeDialAttempt(
        @Path("id") orderId: String,
        @Body body: ExchangeDialAttemptStartRequest,
    ): Response<ExchangeDialAttemptStartResponse>

    @PUT("agent/exchange/dial-attempts/{attemptId}/step1")
    suspend fun reportExchangeStep1(
        @Path("attemptId") attemptId: String,
        @Body body: ExchangeStepRequest,
    ): Response<ExchangeDialAttemptDto>

    @PUT("agent/exchange/dial-attempts/{attemptId}/step2")
    suspend fun reportExchangeStep2(
        @Path("attemptId") attemptId: String,
        @Body body: ExchangeStepRequest,
    ): Response<ExchangeDialAttemptDto>

    // ---------------- Reseller Withdraw (automatic payout — see ussd/ResellerWithdrawalUssdOrchestrator.kt) ----------------
    // Same one-shot combined-string USSD dial as Internet Store above (not
    // Money Exchange's two-step interactive PIN flow) — reuses UssdDialer,
    // not ExchangeUssdDialer. Deliberately separate endpoints/models from
    // both existing pipelines: the automation is analogous to Internet
    // Store's, but a dial result here never completes the withdrawal itself
    // (only the real outgoing SMS does — see this file's/backend's own doc
    // comments), which is why this isn't just reusing startDialAttempt/
    // reportDialResult above.

    @GET("agent/reseller-withdrawals/pending-payout")
    suspend fun getResellerWithdrawalsPendingPayout(): Response<List<ResellerWithdrawalPendingPayout>>

    @POST("agent/reseller-withdrawals/{id}/dial-attempts")
    suspend fun startResellerWithdrawalDialAttempt(
        @Path("id") withdrawalId: String,
        @Body body: DialAttemptStartRequest,
    ): Response<DialAttemptStartResponse>

    @PUT("agent/reseller-withdrawal-dial-attempts/{attemptId}")
    suspend fun reportResellerWithdrawalDialResult(
        @Path("attemptId") attemptId: String,
        @Body body: DialAttemptResultRequest,
    ): Response<DialAttemptResultResponse>

    // Reseller Withdraw's OWN SIM routing (company -> device + physical
    // slot) — deliberately separate from getSimRouting above (which is
    // Internet Store/eBadal recharge's own routing table), so a Reseller
    // Withdraw payout SIM can be managed independently. Mirrors
    // getSimRouting's shape/scoping exactly (see SimRoutingRepository.kt).
    @GET("agent/reseller-withdrawal-sim-routing")
    suspend fun getResellerWithdrawalSimRouting(@Query("deviceId") deviceId: String? = null): Response<List<ResellerWithdrawalSimRoutingEntry>>
}
