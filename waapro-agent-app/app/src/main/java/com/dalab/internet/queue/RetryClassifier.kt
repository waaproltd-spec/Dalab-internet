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
     * responded — a 5xx (transient, server-side) is retryable, and so are
     * 429 (rate limited) and 408 (request timeout), both classic "try again
     * later" signals rather than a rejection of the request itself. Any
     * other 4xx means the request itself is invalid/rejected — not retryable. */
    fun isRetryable(e: Throwable): Boolean = when (e) {
        is IOException -> true
        is HttpException -> e.code() in 500..599 || e.code() == 429 || e.code() == 408
        // An unrecognized throwable (not IOException, not HttpException) is an
        // unexpected client-side condition — e.g. a telephony-stack exception
        // escaping the dial call, or a JSON deserialization bug — not a
        // confirmed server rejection. Treat it as retryable rather than
        // silently dropping a queued action for something that was never
        // actually the server's "no."
        else -> true
    }

    /** Throws HttpException for a non-2xx response so callers can funnel both
     * transport-level and HTTP-level failures through the single isRetryable(Throwable). */
    fun <T> requireSuccessful(response: Response<T>): Response<T> {
        if (!response.isSuccessful) throw HttpException(response)
        return response
    }
}
