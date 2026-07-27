package com.dalab.internet.queue

import retrofit2.HttpException
import retrofit2.Response
import java.io.IOException

/**
 * Distinguishes "no connectivity right now, try again later" from "the
 * server actually rejected this request" — blindly retrying a rejected
 * request forever would waste queue space and can never succeed.
 */
object RetryClassifier {
    /** No HTTP response was received at all (IOException — covers
     * UnknownHostException, SocketTimeoutException, ConnectException, etc.)
     * is retryable; a completed HttpException means the server actually
     * responded, and only a 5xx (transient, server-side) is retryable —
     * a 4xx means the request itself is invalid/rejected. */
    fun isRetryable(e: Throwable): Boolean = when (e) {
        is IOException -> true
        is HttpException -> e.code() in 500..599
        else -> false
    }

    /** Throws HttpException for a non-2xx response so callers can funnel both
     * transport-level and HTTP-level failures through the single isRetryable(Throwable). */
    fun <T> requireSuccessful(response: Response<T>): Response<T> {
        if (!response.isSuccessful) throw HttpException(response)
        return response
    }
}
