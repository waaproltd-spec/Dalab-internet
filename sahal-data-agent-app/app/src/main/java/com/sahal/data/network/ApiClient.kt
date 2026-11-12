package com.sahal.data.network

import com.sahal.data.auth.SessionManager
import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object ApiClient {

    // Production backend for this whole project: sahal-data-admin-backend-ts
    // (Node.js + Express + TypeScript + PostgreSQL), deployed on Render.
    // For local testing against `npm run dev` on a dev machine from an
    // Android emulator, use "http://10.0.2.2:4000/" (the emulator's alias
    // for the host's localhost); from a physical device on the same LAN,
    // use the host machine's LAN IP instead.
    const val BASE_URL = "https://dalab-api.waaproltd.com/"

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
            .client(OkHttpClient.Builder().connectTimeout(45, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS).build())
            .addConverterFactory(GsonConverterFactory.create())
            .build()
    }
    private val plainService: ApiService by lazy { plainRetrofit.create(ApiService::class.java) }

    // Guards the refresh call below against a thundering-herd race: several
    // requests (a queued backlog draining after connectivity returns, a
    // heartbeat tick, a live SMS upload) can all get a 401 within the same
    // moment once the 15-minute access token naturally expires. OkHttp
    // invokes the Authenticator once per failed request with no built-in
    // de-duplication, and the backend's refresh token is single-use/rotated
    // (see auth.routes.ts) — without this lock, every one of those
    // concurrent callers would independently try to consume the SAME
    // refresh token, exactly one would succeed, and every other one would
    // get "refresh token revoked" back from the server and force a real
    // logout for no actual reason (the session was never really dead).
    private val refreshLock = Any()

    /**
     * Shared token refresh used by normal API requests and the SSE client.
     *
     * If another request already refreshed the session while this request
     * was waiting for the lock, reuse the newer access token instead of
     * consuming the single-use refresh token a second time.
     */
    fun refreshSession(failedAccessToken: String?): Boolean {
        synchronized(refreshLock) {
            val storedToken = SessionManager.accessToken()

            if (
                storedToken != null &&
                failedAccessToken != null &&
                storedToken != failedAccessToken
            ) {
                return true
            }

            val refreshToken = SessionManager.refreshToken()
            if (refreshToken == null) {
                SessionManager.clear()
                AgentEventBus.emitSessionExpired()
                return false
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
                AgentEventBus.emitSessionExpired()
                return false
            }

            SessionManager.updateTokens(
                newTokens.accessToken,
                newTokens.refreshToken
            )
            return true
        }
    }

    // Normal Retrofit requests use the same shared refresh path as SSE.
    private val refreshAuthenticator = Authenticator { _, response ->
        if (responseCount(response) >= 2) {
            SessionManager.clear()
            AgentEventBus.emitSessionExpired()
            return@Authenticator null
        }

        val failedAccessToken =
            response.request.header("Authorization")?.removePrefix("Bearer ")

        if (!refreshSession(failedAccessToken)) {
            return@Authenticator null
        }

        val newAccessToken = SessionManager.accessToken()
            ?: return@Authenticator null

        response.request.newBuilder()
            .header("Authorization", "Bearer $newAccessToken")
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

    // The backend runs on Render's free tier, which spins the instance down
    // after ~15 minutes idle and can take 30-60+ seconds to cold-start on the
    // next request. A 15s timeout was shorter than that window, so the very
    // first request after any idle period (most commonly login, the first
    // thing the app calls) failed with a generic connection error even
    // though the server was simply waking up, not actually unreachable.
    private val okHttpClient = OkHttpClient.Builder()
        .addInterceptor(authInterceptor)
        .authenticator(refreshAuthenticator)
        .connectTimeout(45, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
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
