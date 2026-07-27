package com.dalab.internet.customer.queue

import retrofit2.HttpException
import retrofit2.Response
import java.io.IOException

/**
 * Distinguishes "no connectivity right now, try again later" from "the
 * server actually rejected this request" — blindly retrying a rejected
 * request forever would waste queue space and can never succeed. Mirrors
 * agent-app's RetryClassifier (no shared module exists between the two apps).
 */
object RetryClassifier {
    fun isRetryable(e: Throwable): Boolean = when (e) {
        is IOException -> true
        is HttpException -> e.code() in 500..599
        else -> false
    }

    fun <T> requireSuccessful(response: Response<T>): Response<T> {
        if (!response.isSuccessful) throw HttpException(response)
        return response
    }
}
