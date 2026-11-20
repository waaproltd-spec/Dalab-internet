package com.dalab.internet.network

import com.dalab.internet.auth.ResellerSessionManager
import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

/**
 * A second, independent Retrofit client for the SAME [ApiService] interface
 * and the SAME backend as [ApiClient] -- it exists only because a reseller
 * login (role "reseller") is a completely separate identity/session from
 * this device's own agent login (role "agent"), which [ApiClient] already
 * carries for every other call in the app (USSD dialing, orders, reports,
 * ...). Mirrors [ApiClient] exactly (auth header, one-shot refresh via a
 * plain unauthenticated client, thundering-herd refresh lock, force-logout
 * after a failed refresh) but reads/writes [ResellerSessionManager] instead
 * of `SessionManager`, so logging a reseller in or out here never touches
 * this device's own agent session, and vice versa.
 */
object ResellerApiClient {

    private val authInterceptor = Interceptor { chain ->
        val token = ResellerSessionManager.accessToken()
        val request = chain.request().newBuilder().apply {
            if (token != null) addHeader("Authorization", "Bearer $token")
        }.build()
        chain.proceed(request)
    }

    // Plain client, no auth header/authenticator -- used only to call
    // /auth/refresh, exactly like ApiClient's own plainService, so
    // refreshing a reseller token can never recursively trigger another
    // refresh attempt.
    private val plainClient = OkHttpClient.Builder().dns(com.dalab.internet.network.Ipv4FirstDns).connectTimeout(15, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS).build()
    private val plainServices = PerSystem { base ->
        Retrofit.Builder()
            .baseUrl(base)
            .client(plainClient)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ApiService::class.java)
    }
    private val plainService: ApiService get() = plainServices.get(ApiClient.BASE_URL)

    // Same thundering-herd guard as ApiClient's refreshLock, scoped to this
    // client's own reseller refresh token instead of the agent one.
    private val refreshLock = Any()

    private val refreshAuthenticator = Authenticator { _, response ->
        if (responseCount(response) >= 2) {
            ResellerSessionManager.clear()
            return@Authenticator null
        }
        synchronized(refreshLock) {
            val requestedWithToken = response.request.header("Authorization")?.removePrefix("Bearer ")
            val storedToken = ResellerSessionManager.accessToken()
            if (storedToken != null && storedToken != requestedWithToken) {
                return@synchronized response.request.newBuilder()
                    .header("Authorization", "Bearer $storedToken")
                    .build()
            }

            val refreshToken = ResellerSessionManager.refreshToken()
            if (refreshToken == null) {
                ResellerSessionManager.clear()
                return@synchronized null
            }

            val newTokens = runBlocking {
                try {
                    val res = plainService.refresh(RefreshRequest(refreshToken))
                    if (res.isSuccessful) res.body() else null
                } catch (_: Exception) {
                    null
                }
            }

            if (newTokens == null) {
                ResellerSessionManager.clear()
                return@synchronized null
            }

            ResellerSessionManager.updateTokens(newTokens.accessToken, newTokens.refreshToken)
            response.request.newBuilder()
                .header("Authorization", "Bearer ${newTokens.accessToken}")
                .build()
        }
    }

    private fun responseCount(response: Response): Int {
        var count = 1
        var prior = response.priorResponse
        while (prior != null) {
            count++
            prior = prior.priorResponse
        }
        return count
    }

    private val okHttpClient = OkHttpClient.Builder().dns(com.dalab.internet.network.Ipv4FirstDns)
        .addInterceptor(authInterceptor)
        .authenticator(refreshAuthenticator)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .build()

    private val services = PerSystem { base ->
        Retrofit.Builder()
            .baseUrl(base)
            .client(okHttpClient)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ApiService::class.java)
    }
    val service: ApiService get() = services.get(ApiClient.BASE_URL)
}
