package com.dalab.internet.network

import retrofit2.HttpException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/** A stable, groupable [category] (used for per-category counters and
 * DiagnosticsLog tags) alongside the existing human-readable [message]. */
data class HeartbeatFailure(val category: String, val message: String)

/**
 * Turns a raw heartbeat-call exception into a specific, human-readable
 * reason instead of a bare exception message -- so the Reliability
 * Dashboard's "Last error" line (and DiagnosticsLog) tells a technician
 * exactly what kind of failure this was (DNS, TLS, timeout, connection
 * refused/failed, HTTP error) rather than an ambiguous stack-trace string.
 */
object HeartbeatFailureClassifier {
    fun classify(e: Throwable): HeartbeatFailure = when (e) {
        is UnknownHostException -> HeartbeatFailure("dns", "DNS resolution failed (${e.message ?: "host not found"})")
        is SSLException -> HeartbeatFailure("tls", "SSL/TLS handshake failed (${e.message ?: e.javaClass.simpleName})")
        is SocketTimeoutException -> HeartbeatFailure("timeout", "Connection timed out (${e.message ?: "no response in time"})")
        is ConnectException -> HeartbeatFailure("connection", "Could not connect to server (${e.message ?: "connection refused/failed"})")
        is HttpException -> HeartbeatFailure("http_${e.code()}", "Server responded with HTTP ${e.code()} (${e.message()})")
        else -> HeartbeatFailure("unknown", "${e.javaClass.simpleName}: ${e.message ?: "unknown error"}")
    }
}
