package com.dalab.internet.network

import com.dalab.internet.auth.SessionManager
import com.dalab.internet.auth.SystemSession
import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object ApiClient {

    // The signed-in system's API (DALAB, Danwadaag, ...), found by the Admin
    // Hub at sign-in from the agent's phone number + PIN -- see
    // auth/HubLogin.kt and auth/SystemSession.kt. Read on every use, so a new
    // sign-in takes effect without restarting anything.
    val BASE_URL: String get() = SystemSession.apiBaseUrl()

    private val authInterceptor = Interceptor { chain ->
        val token = SessionManager.accessToken()
        val request = chain.request().newBuilder().apply {
            if (token != null) addHeader("Authorization", "Bearer $token")
            // Device Activation: the backend only serves agent APIs to an
            // admin-approved install (deviceActivation.routes.ts).
            addHeader(com.dalab.internet.auth.DeviceInstall.HEADER, com.dalab.internet.auth.DeviceInstall.id())
        }.build()
        val response = chain.proceed(request)
        if (response.code == 403 && response.header("X-Device-Activation") == "required") {
            com.dalab.internet.auth.DeviceActivationState.markNotActivated()
        }
        response
    }

    // A separate, plain client with no auth header and no authenticator —
    // used only to call /auth/refresh, so refreshing a token can never
    // recursively trigger another refresh attempt.
    private val plainClient = OkHttpClient.Builder().connectTimeout(45, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS).build()
    private val plainServices = PerSystem { base ->
        Retrofit.Builder()
            .baseUrl(base)
            .client(plainClient)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ApiService::class.java)
    }
    private val plainService: ApiService get() = plainServices.get(BASE_URL)

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
        .authenticator(refreshAuthenticator)
        .connectTimeout(45, TimeUnit.SECONDS)
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
    val service: ApiService get() = services.get(BASE_URL)
}

/** One client per base URL, rebuilt only when the signed-in system changes. */
internal class PerSystem<T : Any>(private val build: (String) -> T) {
    @Volatile private var current: Pair<String, T>? = null
    fun get(base: String): T {
        current?.let { if (it.first == base) return it.second }
        synchronized(this) {
            current?.let { if (it.first == base) return it.second }
            return build(base).also { current = base to it }
        }
    }
}
