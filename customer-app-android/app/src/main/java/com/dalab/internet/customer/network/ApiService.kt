package com.dalab.internet.customer.network

import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.CustomerProfile
import com.dalab.internet.customer.data.NotificationItem
import com.dalab.internet.customer.data.PackageItem
import com.dalab.internet.customer.data.PaymentWallet
import com.dalab.internet.customer.data.PromoImage
import com.dalab.internet.customer.data.ServiceCategory
import retrofit2.Response
import retrofit2.http.*

data class OtpRequestBody(val phone: String)
data class OtpRequestResponse(val message: String, val otpCode: String? = null)
data class OtpVerifyBody(val phone: String, val code: String)
// pinSet is additive on top of the existing OTP response — false for every
// customer who never created one, so the login flow behaves exactly as
// before unless the customer opted into this optional feature themselves.
data class OtpVerifyResponse(val accessToken: String, val refreshToken: String, val customer: CustomerProfile, val pinSet: Boolean = false)
data class RefreshRequest(val refreshToken: String)
data class RefreshResponse(val accessToken: String, val refreshToken: String)
data class UpdateProfileRequest(val name: String)
data class PinBody(val pin: String)
data class PinStatusResponse(val isSet: Boolean)
data class PinVerifyResponse(val valid: Boolean)
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

    // Optional, customer-facing login PIN — entirely separate from the
    // required phone+OTP flow above; a customer who never calls setPin stays
    // unaffected (pin-status is simply always "not set" for them).
    @GET("customer/pin-status")
    suspend fun getPinStatus(): Response<PinStatusResponse>

    @PUT("customer/pin")
    suspend fun setPin(@Body body: PinBody): Response<Unit>

    @DELETE("customer/pin")
    suspend fun removePin(): Response<Unit>

    @POST("customer/pin/verify")
    suspend fun verifyPin(@Body body: PinBody): Response<PinVerifyResponse>

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

    @GET("companies/{id}/categories")
    suspend fun getCategories(@Path("id") companyId: String): Response<List<ServiceCategory>>

    @POST("orders")
    suspend fun createOrder(@Body body: CreateOrderRequest): Response<CustomerOrder>

    @GET("orders")
    suspend fun getOrders(): Response<List<CustomerOrder>>

    @GET("orders/{id}")
    suspend fun getOrder(@Path("id") id: String): Response<CustomerOrder>
}
