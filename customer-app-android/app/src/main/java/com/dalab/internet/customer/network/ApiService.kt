package com.dalab.internet.customer.network

import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.CustomerProfile
import com.dalab.internet.customer.data.MacaashBalance
import com.dalab.internet.customer.data.PackageItem
import retrofit2.Response
import retrofit2.http.*

data class OtpRequestBody(val phone: String)
data class OtpRequestResponse(val message: String, val debugCode: String? = null)
data class OtpVerifyBody(val phone: String, val code: String)
data class OtpVerifyResponse(val accessToken: String, val refreshToken: String, val customer: CustomerProfile)
data class RefreshRequest(val refreshToken: String)
data class RefreshResponse(val accessToken: String, val refreshToken: String)
data class UpdateProfileRequest(val name: String)
data class CreateOrderRequest(
    val companyId: String,
    val packageId: String,
    val receiverPhone: String? = null,
    val paymentMethod: String? = null,
)

/**
 * Mirrors admin-backend-ts's routes exactly (src/routes/*.routes.ts) — the
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

    @GET("companies")
    suspend fun getCompanies(): Response<List<Company>>

    @GET("companies/{id}/packages")
    suspend fun getPackages(@Path("id") companyId: String): Response<List<PackageItem>>

    @POST("orders")
    suspend fun createOrder(@Body body: CreateOrderRequest): Response<CustomerOrder>

    @GET("orders")
    suspend fun getOrders(): Response<List<CustomerOrder>>

    @GET("orders/{id}")
    suspend fun getOrder(@Path("id") id: String): Response<CustomerOrder>

    @GET("macaash/balance")
    suspend fun getMacaashBalance(): Response<MacaashBalance>
}
