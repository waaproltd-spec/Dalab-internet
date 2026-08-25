package com.dalab.internet.customer.network

import com.dalab.internet.customer.data.Company
import com.dalab.internet.customer.data.CreateExchangeOrderRequest
import com.dalab.internet.customer.data.CustomerOrder
import com.dalab.internet.customer.data.CustomerProfile
import com.dalab.internet.customer.data.ExchangeCorridor
import com.dalab.internet.customer.data.ExchangeOrder
import com.dalab.internet.customer.data.ExchangeQuote
import com.dalab.internet.customer.data.ExchangeWallet
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
data class RegisterDeviceTokenRequest(val fcmToken: String)
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
    // Referral / Loyalty Points: optional discount applied at order creation.
    // Omitted (null) means "don't redeem any points," identical to today.
    val useLoyaltyPoints: Int? = null,
)

// Referral / Loyalty Points — reuses the existing Macaash balance/ledger as
// the one points currency; see admin-backend-ts's referrals.routes.ts.
data class ReferralEntry(
    val id: String,
    val name: String?,
    val phone: String,
    val joinedAt: String,
    val hasCompletedPurchase: Boolean,
)

data class ReferralInfo(
    val referralCode: String,
    val referralLink: String,
    val pointsBalance: Int,
    val pointsEarnedFromReferrals: Int,
    val pointsUsedForDiscounts: Int,
    val pointsPerDollarDiscount: Int,
    val referrals: List<ReferralEntry>,
)

// Each field is null when that link is unconfigured or disabled — see
// GET /settings/public (admin-backend-ts/src/routes/settings.routes.ts).
data class SocialLinks(
    val whatsappNumber: String? = null,
    val phoneNumber: String? = null,
    val facebookUrl: String? = null,
    val instagramUrl: String? = null,
    val tiktokUrl: String? = null,
    val email: String? = null,
    val playStoreUrl: String? = null,
)

data class PublicSettings(
    val appName: String? = null,
    val supportPhone: String? = null,
    val socialLinks: SocialLinks = SocialLinks(),
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

    // Called once on login/app-start with this device's current FCM token,
    // and again whenever Firebase rotates it -- see notifications/PushTokenRegistrar.kt
    // and notifications/CustomerFcmService.kt.
    @POST("notifications/register-device")
    suspend fun registerDeviceToken(@Body body: RegisterDeviceTokenRequest): Response<Unit>

    // Called on logout so a shared/reset device stops receiving the
    // previous customer's pushes.
    @POST("notifications/unregister-device")
    suspend fun unregisterDeviceToken(@Body body: RegisterDeviceTokenRequest): Response<Unit>

    // audience=customer additionally hides a company that's offline or
    // hidden from the Customer App specifically — the backend leaves every
    // other caller (e.g. the Agent App) unfiltered when this param is absent.
    @GET("companies")
    suspend fun getCompanies(@Query("audience") audience: String = "customer"): Response<List<Company>>

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

    @GET("customers/me/referral")
    suspend fun getReferralInfo(): Response<ReferralInfo>

    // ---------------- Money Exchange (separate main service from Internet Store) ----------------

    @GET("exchange/wallets")
    suspend fun getExchangeWallets(): Response<List<ExchangeWallet>>

    @GET("exchange/corridors")
    suspend fun getExchangeCorridors(): Response<List<ExchangeCorridor>>

    @GET("exchange/quote")
    suspend fun getExchangeQuote(@Query("corridorId") corridorId: String, @Query("amount") amount: Double): Response<ExchangeQuote>

    @POST("exchange/orders")
    suspend fun createExchangeOrder(@Body body: CreateExchangeOrderRequest): Response<ExchangeOrder>

    @GET("exchange/orders")
    suspend fun getExchangeOrders(): Response<List<ExchangeOrder>>

    @GET("exchange/orders/{id}")
    suspend fun getExchangeOrder(@Path("id") id: String): Response<ExchangeOrder>

    // Social Media Links (Super Admin: Settings -> Social Media Links) — a
    // field is null whenever it's either unconfigured or switched off, so
    // the Profile screen can hide/disable that button with no guessing.
    // No auth required, matches the endpoint's own public design.
    @GET("settings/public")
    suspend fun getPublicSettings(): Response<PublicSettings>
}
