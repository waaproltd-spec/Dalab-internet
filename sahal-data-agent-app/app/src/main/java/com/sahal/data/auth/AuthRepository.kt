package com.sahal.data.auth

import com.sahal.data.network.ApiClient
import com.sahal.data.network.DeviceLoginRequest
import java.net.SocketTimeoutException

sealed class LoginResult {
    data class Success(val agentName: String) : LoginResult()
    data class Failure(val message: String) : LoginResult()
}

object AuthRepository {
    /** No credentials involved — this device authenticates as whichever agent
     * the Super Admin has assigned to it (agents.device_id). */
    suspend fun loginWithDevice(deviceId: String): LoginResult {
        return try {
            val response = ApiClient.service.deviceLogin(DeviceLoginRequest(deviceId))
            val body = response.body()
            if (response.isSuccessful && body != null) {
                SessionManager.saveSession(body.accessToken, body.refreshToken, body.agent)
                LoginResult.Success(body.agent.name)
            } else if (response.code() == 404) {
                LoginResult.Failure("No agent account is assigned to this device yet. Ask your Super Admin to assign one from the dashboard.")
            } else {
                LoginResult.Failure("Couldn't sign in to this device. Please try again.")
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
}
