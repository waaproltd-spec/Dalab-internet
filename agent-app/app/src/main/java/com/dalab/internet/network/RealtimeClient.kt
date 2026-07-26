package com.dalab.internet.network

import com.dalab.internet.auth.SessionManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.TimeUnit

/**
 * Keeps the Agent App's order list live without polling, via Server-Sent
 * Events against `GET /$path` (see `GET /agent/orders/stream` in
 * admin-backend-ts). Replaces the previous dead-code WebSocket client, which
 * pointed at a `wss://` endpoint the backend never actually implemented.
 *
 * The server only ever sends a bare `{"type":...,"orderId":...}` — this just
 * signals the caller to re-fetch its own list/order rather than trusting the
 * event payload, same philosophy the old client used.
 */
class RealtimeClient(private val path: String, private val onOrderEvent: () -> Unit) {

    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS) // SSE connections stay open indefinitely
        .build()
    private var eventSource: EventSource? = null
    private var scope: CoroutineScope? = null
    private var retryDelayMs = 2_000L

    fun connect() {
        disconnect()
        val newScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope = newScope
        open(newScope)
    }

    private fun open(scope: CoroutineScope) {
        val token = SessionManager.accessToken() ?: return
        val request = Request.Builder()
            .url("${ApiClient.BASE_URL}$path")
            .header("Authorization", "Bearer $token")
            .header("Accept", "text/event-stream")
            .build()

        eventSource = EventSources.createFactory(client).newEventSource(
            request,
            object : EventSourceListener() {
                override fun onOpen(eventSource: EventSource, response: Response) {
                    retryDelayMs = 2_000L
                }

                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    onOrderEvent()
                }

                override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                    scheduleReconnect(scope)
                }

                override fun onClosed(eventSource: EventSource) {
                    scheduleReconnect(scope)
                }
            }
        )
    }

    private fun scheduleReconnect(scope: CoroutineScope) {
        if (!scope.isActive) return
        scope.launch {
            delay(retryDelayMs)
            retryDelayMs = (retryDelayMs * 2).coerceAtMost(30_000L)
            if (isActive) open(scope)
        }
    }

    fun disconnect() {
        eventSource?.cancel()
        eventSource = null
        scope?.cancel()
        scope = null
    }
}
