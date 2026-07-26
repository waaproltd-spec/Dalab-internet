package com.dalab.internet.auth

import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.LoginRequest

sealed class LoginResult {
    data class Success(val agentName: String) : LoginResult()
    data class Failure(val message: String) : LoginResult()
}

object AuthRepository {
    suspend fun login(phone: String, password: String): LoginResult {
        return try {
            val response = ApiClient.service.login(LoginRequest(phone, password))
            val body = response.body()
            if (response.isSuccessful && body != null) {
                SessionManager.saveSession(body.accessToken, body.refreshToken, body.agent)
                LoginResult.Success(body.agent.name)
            } else {
                LoginResult.Failure("Invalid phone or password")
            }
        } catch (e: Exception) {
            LoginResult.Failure("Couldn't reach the server. Check your connection.")
        }
    }

    fun logout() {
        SessionManager.clear()
    }
}
