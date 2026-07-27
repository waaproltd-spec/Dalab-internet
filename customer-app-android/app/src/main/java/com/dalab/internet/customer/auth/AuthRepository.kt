package com.dalab.internet.customer.auth

import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.OtpRequestBody
import com.dalab.internet.customer.network.OtpVerifyBody

sealed class OtpRequestResult {
    data class Sent(val otpCode: String?) : OtpRequestResult()
    data class Failure(val message: String) : OtpRequestResult()
}

sealed class OtpVerifyResult {
    data class Success(val name: String?) : OtpVerifyResult()
    data class Failure(val message: String) : OtpVerifyResult()
}

object AuthRepository {
    suspend fun requestOtp(phone: String): OtpRequestResult {
        return try {
            val response = ApiClient.service.requestOtp(OtpRequestBody(phone))
            if (response.isSuccessful) OtpRequestResult.Sent(response.body()?.otpCode)
            else OtpRequestResult.Failure("Couldn't send a code to that number. Check it and try again.")
        } catch (e: Exception) {
            OtpRequestResult.Failure("Couldn't reach the server. Check your connection.")
        }
    }

    suspend fun verifyOtp(phone: String, code: String): OtpVerifyResult {
        return try {
            val response = ApiClient.service.verifyOtp(OtpVerifyBody(phone, code))
            val body = response.body()
            if (response.isSuccessful && body != null) {
                SessionManager.saveSession(body.accessToken, body.refreshToken, body.customer)
                OtpVerifyResult.Success(body.customer.name)
            } else {
                OtpVerifyResult.Failure("Incorrect code. Check the digits and try again.")
            }
        } catch (e: Exception) {
            OtpVerifyResult.Failure("Couldn't reach the server. Check your connection.")
        }
    }

    fun logout() {
        SessionManager.clear()
    }
}
