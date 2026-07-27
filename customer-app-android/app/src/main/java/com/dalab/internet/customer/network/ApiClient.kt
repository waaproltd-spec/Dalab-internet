package com.dalab.internet.customer.network

import com.dalab.internet.customer.auth.SessionManager
import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object ApiClient {

    // Production backend for this whole project: dalab-admin-backend-ts
    // (Node.js + Express + TypeScript + PostgreSQL), deployed on Render.
    // For local testing against `npm run dev` on a dev machine from an
    // Android emulator, use "http://10.0.2.2:4000/" (the emulator's alias
    // for the host's localhost); from a physical device on the same LAN,
    // use the host machine's LAN IP instead.
    const val BASE_URL = "https://dalab-admin-backend.onrender.com/"

    private val authInterceptor = Interceptor { chain ->
        val token = SessionManager.accessToken()
        val request = chain.request().newBuilder().apply {
            if (token != null) addHeader("Authorization", "Bearer $token")
        }.build()
        chain.proceed(request)
    }

    // A separate, plain client with no auth header and no authenticator —
    // used only to call /auth/refresh, so refreshing a token can never
    // recursively trigger another refresh attempt.
    private val plainRetrofit: Retrofit by lazy {
        Retrofit.Builder()
            .baseUrl(BASE_URL)
            .client(OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).build())
            .addConverterFactory(GsonConverterFactory.create())
            .build()
    }
    private val plainService: ApiService by lazy { plainRetrofit.create(ApiService::class.java) }

    // Real 401 handling: on a 401, attempt exactly one token refresh (never an
    // infinite loop — responseCount guards that), retry the original request
    // with the new access token, and only fall back to forcing re-login if the
    // refresh itself fails (refresh token expired/revoked).
    private val refreshAuthenticator = Authenticator { _, response ->
        if (responseCount(response) >= 2) {
            SessionManager.clear()
            return@Authenticator null
        }
        val refreshToken = SessionManager.refreshToken()
        if (refreshToken == null) {
            SessionManager.clear()
            return@Authenticator null
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
            SessionManager.clear()
            return@Authenticator null
        }

        SessionManager.updateTokens(newTokens.accessToken, newTokens.refreshToken)
        response.request.newBuilder()
            .header("Authorization", "Bearer ${newTokens.accessToken}")
            .build()
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

    private val okHttpClient = OkHttpClient.Builder()
        .addInterceptor(authInterceptor)
        .authenticator(refreshAuthenticator)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    val service: ApiService by lazy {
        Retrofit.Builder()
            .baseUrl(BASE_URL)
            .client(okHttpClient)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ApiService::class.java)
    }
}
