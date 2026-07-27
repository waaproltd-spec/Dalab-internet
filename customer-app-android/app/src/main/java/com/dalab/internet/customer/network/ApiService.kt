package com.dalab.internet.customer.network

import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.CustomerProfile
import com.dalab.internet.customer.data.NotificationItem
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.data.PaymentWallet
import com.dalab.internet.customer.data.PromoImage
import retrofit2.Response
import retrofit2.http.*

data class OtpRequestBody(val phone: String)
data class OtpRequestResponse(val message: String, val otpCode: String? = null)
data class OtpVerifyBody(val phone: String, val code: String)
data class OtpVerifyResponse(val accessToken: String, val refreshToken: String, val customer: CustomerProfile)
data class RefreshRequest(val refreshToken: String)
data class RefreshResponse(val accessToken: String, val refreshToken: String)
data class UpdateProfileRequest(val name: String)
data class CreateOrderRequest(
    val companyId: String,
    val packageId: String,
    val senderPhone: String? = null,
    val receiverPhone: String? = null,
    val paymentMethod: String? = null,
    val clientRequestId: String? = null,
)

/**
 * Mirrors admin-backend-ts's routes exactly (src/routes/ *.routes.ts) — the
 * production backend for this whole project. Base URL and auth header
 * (Authorization: Bearer <token>) are attached in ApiClient's OkHttp
 * interceptor, not here.
 */
interface ApiService {

    @POST("auth/otp/request")
    suspend fun requestOtp(@Body body: OtpRequestBody): Response<OtpRequestResponse>

    @POST("auth/otp/verify")
    suspend fun verifyOtp(@Body body: OtpVerifyBody): Response<OtpVerifyResponse>

    @POST("auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): Response<RefreshResponse>

    @GET("customer/profile")
    suspend fun getProfile(): Response<CustomerProfile>

    @PUT("customer/profile")
    suspend fun updateProfile(@Body body: UpdateProfileRequest): Response<CustomerProfile>

    @DELETE("customer/profile")
    suspend fun deleteAccount(): Response<Unit>

    @GET("promo-images")
    suspend fun getPromoImages(): Response<List<PromoImage>>

    @GET("notifications")
    suspend fun getNotifications(): Response<List<NotificationItem>>

    @GET("companies")
    suspend fun getCompanies(): Response<List<Company>>

    @GET("payment-wallets")
    suspend fun getPaymentWallets(): Response<List<PaymentWallet>>

    @GET("companies/{id}/packages")
    suspend fun getPackages(@Path("id") companyId: String): Response<List<PackageItem>>

    @POST("orders")
    suspend fun createOrder(@Body body: CreateOrderRequest): Response<CustomerOrder>

    @GET("orders")
    suspend fun getOrders(): Response<List<CustomerOrder>>

    @GET("orders/{id}")
    suspend fun getOrder(@Path("id") id: String): Response<CustomerOrder>
}
