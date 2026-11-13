package com.dalab.internet.auth

import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.LoginResponse
import com.google.gson.Gson
import com.google.gson.JsonObject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

/** The system the Admin Hub found for this phone + PIN. */
data class SignedInSystem(val key: String, val name: String, val apiUrl: String)

sealed class HubLoginResult {
    data class Success(val system: SignedInSystem, val agentName: String) : HubLoginResult()
    data class Failure(val message: String) : HubLoginResult()
}

/**
 * Sign-in for the one AGENT APP that serves every system.
 *
 *  1. Phone number + PIN go to the Admin Hub (POST /api/agent/login). The hub
 *     asks every system at once and answers with the ONE system whose agent
 *     this is, plus a single-use, 60-second pass for that system only.
 *     Every refusal (wrong PIN, unknown number, a number shared by two
 *     systems, locked, ...) comes with a neutral message that names no system.
 *  2. The pass goes to that system's own API (POST /agent/auth/hub-login),
 *     which starts its normal agent session (the same tokens the app always
 *     used). From then on the app talks only to that system.
 *
 * The PIN never goes anywhere but the hub, over HTTPS.
 */
object HubLogin {
    const val HUB_URL = "https://admin.waaproltd.com/"

    private val JSON = "application/json; charset=utf-8".toMediaType()
    private val gson = Gson()

    // Each system answers the hub within 8 s; the hub adds a 1.2 s floor.
    private val client = OkHttpClient.Builder().dns(com.dalab.internet.network.Ipv4FirstDns)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .build()

    suspend fun signIn(phone: String, pin: String): HubLoginResult = withContext(Dispatchers.IO) {
        try {
            val hubBody = JsonObject().apply {
                addProperty("phone", phone)
                addProperty("pin", pin)
            }
            val hub = post("${HUB_URL}api/agent/login", hubBody)
            if (hub.code != 200) {
                return@withContext HubLoginResult.Failure(
                    hub.json?.get("error")?.takeIf { it.isJsonPrimitive }?.asString
                        ?: "Couldn't sign in. Please try again."
                )
            }
            val system = hub.json?.getAsJsonObject("system")
            val handoff = hub.json?.get("handoff")?.asString
            val key = system?.get("key")?.asString
            val name = system?.get("name")?.asString ?: key
            val apiUrl = system?.get("apiUrl")?.asString?.trimEnd('/')
            if (key == null || name == null || apiUrl == null || handoff == null || !isSafeApiUrl(apiUrl)) {
                DiagnosticsLog.record("hub_login", "Unexpected answer from the Admin Hub (HTTP ${hub.code}).")
                return@withContext HubLoginResult.Failure("Couldn't sign in. Please try again.")
            }

            val sys = post("$apiUrl/agent/auth/hub-login", JsonObject().apply { addProperty("handoff", handoff) })
            val session = sys.json?.let { runCatching { gson.fromJson(it, LoginResponse::class.java) }.getOrNull() }
            if (sys.code != 200 || session?.accessToken == null || session.refreshToken == null || session.agent == null) {
                return@withContext HubLoginResult.Failure(
                    sys.json?.get("error")?.takeIf { it.isJsonPrimitive }?.asString
                        ?: "Couldn't sign in. Please try again."
                )
            }

            val signedIn = SignedInSystem(key, name, apiUrl)
            SystemSwitch.prepareFor(signedIn)
            SessionManager.saveSession(session.accessToken, session.refreshToken, session.agent)
            DiagnosticsLog.record("hub_login", "Signed in to $name as ${session.agent.name}.", isError = false)
            HubLoginResult.Success(signedIn, session.agent.name)
        } catch (e: SocketTimeoutException) {
            HubLoginResult.Failure("The server is taking too long to answer. Please try again.")
        } catch (e: Exception) {
            DiagnosticsLog.record("hub_login", "Sign-in failed: ${e.javaClass.simpleName}: ${e.message}")
            HubLoginResult.Failure("Couldn't reach the server. Check your connection.")
        }
    }

    /** Only an https:// address on a waaproltd.com host is accepted as a system's API. */
    internal fun isSafeApiUrl(url: String): Boolean {
        val parsed = url.toHttpUrlOrNull() ?: return false
        return parsed.isHttps && (parsed.host == "waaproltd.com" || parsed.host.endsWith(".waaproltd.com"))
    }

    private class Answer(val code: Int, val json: JsonObject?)

    private fun post(url: String, body: JsonObject): Answer {
        val request = Request.Builder().url(url).post(gson.toJson(body).toRequestBody(JSON)).build()
        client.newCall(request).execute().use { res ->
            val text = res.body?.string().orEmpty()
            val json = runCatching { gson.fromJson(text, JsonObject::class.java) }.getOrNull()
            return Answer(res.code, json)
        }
    }
}
