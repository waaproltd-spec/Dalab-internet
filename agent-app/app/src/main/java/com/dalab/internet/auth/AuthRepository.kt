package com.dalab.internet.auth

import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.DeviceLoginRequest
import com.google.gson.Gson
import retrofit2.Response
import java.net.SocketTimeoutException

sealed class LoginResult {
    data class Success(val agentName: String) : LoginResult()
    // code mirrors the backend's machine-readable error code (see
    // auth.routes.ts's /agent/auth/device-login) when there is one --
    // DEVICE_DISABLED or INVALID_ACTIVATION_CODE -- so the screen can react
    // differently (e.g. offer an activation-code field only for the latter).
    data class Failure(val message: String, val code: String? = null) : LoginResult()
}

private data class DeviceLoginErrorBody(val error: String? = null, val code: String? = null)

object AuthRepository {
    /** The device itself (agents.device_id) determines which agent this app
     * authenticates as -- no separate credential for that. activationCode is
     * only required when an admin has explicitly set one for this specific
     * device (see agent_devices.activation_code_hash); most devices have
     * none and a blank/null code works exactly as before this existed. */
    suspend fun loginWithDevice(deviceId: String, activationCode: String? = null): LoginResult {
        return try {
            val response = ApiClient.service.deviceLogin(DeviceLoginRequest(deviceId, activationCode))
            val body = response.body()
            if (response.isSuccessful && body != null) {
                SessionManager.saveSession(body.accessToken, body.refreshToken, body.agent)
                LoginResult.Success(body.agent.name)
            } else {
                val errorCode = parseErrorCode(response)
                val message = when {
                    errorCode == "DEVICE_DISABLED" -> "This device has been disabled by an administrator. Contact them to restore access."
                    errorCode == "INVALID_ACTIVATION_CODE" -> "Incorrect activation code. Ask your administrator for the code issued for this device."
                    response.code() == 404 -> "No agent account is assigned to this device yet. Ask your Super Admin to assign one from the dashboard."
                    else -> "Couldn't sign in to this device. Please try again."
                }
                LoginResult.Failure(message, errorCode)
            }
        } catch (e: SocketTimeoutException) {
            // The backend can take 30-60s to wake up after being idle — this is
            // the most common cause of a timeout here, not a real connectivity
            // problem, so tell the agent to just wait and retry.
            LoginResult.Failure("The server is waking up after being idle — this can take up to a minute. Please try again.")
        } catch (e: Exception) {
            LoginResult.Failure("Couldn't reach the server. Check your connection.")
        }
    }

    private fun parseErrorCode(response: Response<*>): String? {
        return try {
            val json = response.errorBody()?.string() ?: return null
            Gson().fromJson(json, DeviceLoginErrorBody::class.java)?.code
        } catch (_: Exception) {
            null
        }
    }
}
