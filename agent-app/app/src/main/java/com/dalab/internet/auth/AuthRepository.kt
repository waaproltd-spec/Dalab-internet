package com.dalab.internet.auth

import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.LoginRequest
import java.net.SocketTimeoutException

sealed class LoginResult {
    data class Success(val agentName: String) : LoginResult()
    data class Failure(val message: String) : LoginResult()
}

object AuthRepository {
    suspend fun login(phone: String): LoginResult {
        return try {
            val response = ApiClient.service.login(LoginRequest(phone))
            val body = response.body()
            if (response.isSuccessful && body != null) {
                SessionManager.saveSession(body.accessToken, body.refreshToken, body.agent)
                LoginResult.Success(body.agent.name)
            } else {
                LoginResult.Failure("No agent account found for this phone number")
            }
        } catch (e: SocketTimeoutException) {
            // The backend can take 30-60s to wake up after being idle — this is
            // the most common cause of a login timeout, not a real connectivity
            // problem, so tell the agent to just wait and retry instead of
            // implying their own network is at fault.
            LoginResult.Failure("The server is waking up after being idle — this can take up to a minute. Please try again.")
        } catch (e: Exception) {
            LoginResult.Failure("Couldn't reach the server. Check your connection.")
        }
    }

    fun logout() {
        SessionManager.clear()
    }
}
