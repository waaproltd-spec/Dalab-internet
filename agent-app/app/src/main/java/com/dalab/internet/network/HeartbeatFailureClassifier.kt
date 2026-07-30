package com.dalab.internet.network

import retrofit2.HttpException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * Turns a raw heartbeat-call exception into a specific, human-readable
 * reason instead of a bare exception message -- so the Reliability
 * Dashboard's "Last error" line (and DiagnosticsLog) tells a technician
 * exactly what kind of failure this was (DNS, TLS, timeout, connection
 * refused/failed, HTTP error) rather than an ambiguous stack-trace string.
 */
object HeartbeatFailureClassifier {
    fun classify(e: Throwable): String = when (e) {
        is UnknownHostException -> "DNS resolution failed (${e.message ?: "host not found"})"
        is SSLException -> "SSL/TLS handshake failed (${e.message ?: e.javaClass.simpleName})"
        is SocketTimeoutException -> "Connection timed out (${e.message ?: "no response in time"})"
        is ConnectException -> "Could not connect to server (${e.message ?: "connection refused/failed"})"
        is HttpException -> "Server responded with HTTP ${e.code()} (${e.message()})"
        else -> "${e.javaClass.simpleName}: ${e.message ?: "unknown error"}"
    }
}
