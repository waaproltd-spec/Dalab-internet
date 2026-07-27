package com.dalab.internet.network

import com.dalab.internet.data.AgentDevice
import com.dalab.internet.data.AgentProfile
import com.dalab.internet.data.AgentReport
import com.dalab.internet.data.Company
import com.dalab.internet.data.CustomerSummary
import com.dalab.internet.data.Order
import com.dalab.internet.data.PackageItem
import com.dalab.internet.data.SmsLogEntry
import com.dalab.internet.data.Transaction
import com.dalab.internet.data.AgentNotification
import com.dalab.internet.ussd.SimRoutingEntry
import retrofit2.Response
import retrofit2.http.*

data class LoginRequest(val phone: String, val password: String)
data class HeartbeatRequest(
    val batteryPercent: Int?,
    val networkOnline: Boolean,
    val sim1Present: Boolean?,
    val sim2Present: Boolean?,
)
data class LoginResponse(val accessToken: String, val refreshToken: String, val agent: AgentProfile)
data class RefreshRequest(val refreshToken: String)
data class RefreshResponse(val accessToken: String, val refreshToken: String)
data class VerifyPaymentRequest(val smsLogId: String? = null)
data class SmsLogUploadResponse(val id: String, val matchedOrderId: String?, val requiresManualApproval: Boolean = false)
data class DialAttemptStartRequest(val simSlot: Int?, val ussdString: String, val attemptNumber: Int)
data class DialAttemptStartResponse(val id: String)
data class DialAttemptResultRequest(val status: String, val responseMessage: String?)
data class DialAttemptResultResponse(val id: String, val status: String)
data class CreateCustomerRequest(val phone: String, val name: String? = null)
data class CreateSaleRequest(
    val customerPhone: String,
    val companyId: String,
    val packageId: String,
    val receiverPhone: String? = null,
    val paymentMethod: String? = null,
    val clientRequestId: String? = null,
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

    @POST("agent/auth/login")
    suspend fun login(@Body body: LoginRequest): Response<LoginResponse>

    @POST("auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): Response<RefreshResponse>

    @GET("agent/orders")
    suspend fun getOrders(@Query("status") status: String? = null): Response<List<Order>>

    @GET("agent/orders/{id}")
    suspend fun getOrder(@Path("id") id: String): Response<Order>

    @POST("agent/orders/{id}/verify-payment")
    suspend fun verifyPayment(
        @Path("id") id: String,
        @Body body: VerifyPaymentRequest,
    ): Response<Order>

    @POST("agent/orders/{id}/complete")
    suspend fun completeOrder(@Path("id") id: String): Response<Order>

    @GET("agent/transactions")
    suspend fun getTransactions(@Query("range") range: String? = null): Response<List<Transaction>>

    @POST("agent/sms-logs")
    suspend fun uploadSmsLog(@Body body: SmsLogEntry): Response<SmsLogUploadResponse>

    @GET("agent/notifications")
    suspend fun getNotifications(): Response<List<AgentNotification>>

    @GET("agent/sim-routing")
    suspend fun getSimRouting(@Query("deviceId") deviceId: String? = null): Response<List<SimRoutingEntry>>

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
}
