package com.dalab.internet.network

import com.dalab.internet.auth.SessionManager
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
    //
    // Points at api.waaproltd.com (a custom domain on the same, unchanged
    // Render backend) rather than the raw onrender.com address specifically
    // so a future server migration only requires repointing DNS, not
    // redistributing this app to every agent device.
    const val BASE_URL = "https://api.waaproltd.com/"

    private val authInterceptor = Interceptor { chain ->
        val token = SessionManager.accessToken()
        val request = chain.request().newBuilder().apply {
            if (token != null) addHeader("Authorization", "Bearer $token")
        }.build()
        chain.proceed(request)
    }

    // An admin disabling this device (see requireAuth in the backend's
    // middleware.ts) shows up as a plain 403 on whichever request happened
    // to be in flight -- OkHttp's Authenticator only ever fires for 401, so
    // this has to be a response Interceptor instead, checked on every call
    // regardless of which endpoint it was. peekBody reads without consuming
    // the stream the real caller still needs. Session is cleared immediately
    // so every subsequent call fails fast instead of one-by-one discovering
    // the device is disabled; the next app open routes back through
    // AutoLoginScreen, which surfaces the real reason.
    private val deviceRevokedInterceptor = Interceptor { chain ->
        val response = chain.proceed(chain.request())
        if (response.code == 403) {
            val snippet = try {
                response.peekBody(512).string()
            } catch (_: Exception) {
                ""
            }
            if (snippet.contains("DEVICE_DISABLED")) {
                SessionManager.clear()
                AgentEventBus.emitDeviceRevoked()
            }
        }
        response
    }

    // A separate, plain client with no auth header and no authenticator —
    // used only to call /auth/refresh, so refreshing a token can never
    // recursively trigger another refresh attempt.
    private val plainRetrofit: Retrofit by lazy {
        Retrofit.Builder()
            .baseUrl(BASE_URL)
            .client(
                OkHttpClient.Builder()
                    .addInterceptor(deviceRevokedInterceptor)
                    .connectTimeout(45, TimeUnit.SECONDS)
                    .readTimeout(45, TimeUnit.SECONDS)
                    .build()
            )
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

    // Real 401 handling: on a 401, attempt exactly one token refresh (never an
    // infinite loop — responseCount guards that), retry the original request
    // with the new access token, and only fall back to forcing re-login if the
    // refresh itself fails (refresh token expired/revoked).
    private val refreshAuthenticator = Authenticator { _, response ->
        if (responseCount(response) >= 2) {
            SessionManager.clear()
            AgentEventBus.emitSessionExpired()
            return@Authenticator null
        }
        synchronized(refreshLock) {
            // Another concurrent request may have already refreshed the
            // token while this one was waiting for the lock — reuse it
            // instead of burning a second, already-invalid refresh token.
            val requestedWithToken = response.request.header("Authorization")?.removePrefix("Bearer ")
            val storedToken = SessionManager.accessToken()
            if (storedToken != null && storedToken != requestedWithToken) {
                return@synchronized response.request.newBuilder()
                    .header("Authorization", "Bearer $storedToken")
                    .build()
            }

            val refreshToken = SessionManager.refreshToken()
            if (refreshToken == null) {
                SessionManager.clear()
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
                SessionManager.clear()
                AgentEventBus.emitSessionExpired()
                return@synchronized null
            }

            SessionManager.updateTokens(newTokens.accessToken, newTokens.refreshToken)
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

    // The backend runs on Render's free tier, which spins the instance down
    // after ~15 minutes idle and can take 30-60+ seconds to cold-start on the
    // next request. A 15s timeout was shorter than that window, so the very
    // first request after any idle period (most commonly login, the first
    // thing the app calls) failed with a generic connection error even
    // though the server was simply waking up, not actually unreachable.
    private val okHttpClient = OkHttpClient.Builder()
        .addInterceptor(authInterceptor)
        .addInterceptor(deviceRevokedInterceptor)
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
