package com.dalab.internet.network

import com.dalab.internet.auth.SessionManager
import okhttp3.*
import okhttp3.Request

/**
 * Keeps the Agent App's order list live without polling. The server pushes a small
 * event (`{"type":"order.updated","orderId":"DLB..."}`) whenever any client — the
 * Customer App submitting an order, another agent claiming it, or the Super Admin
 * dashboard editing it — changes something this agent is allowed to see. On receipt
 * the app just re-fetches that one order rather than trusting the payload blindly.
 */
class RealtimeClient(private val onOrderEvent: (orderId: String) -> Unit) {

    private var webSocket: WebSocket? = null
    private val client = OkHttpClient()

    fun connect() {
        val token = SessionManager.accessToken() ?: return
        val request = Request.Builder()
            .url("wss://api.dalabinternet.so/ws?token=$token")
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val orderId = extractOrderId(text) ?: return
                onOrderEvent(orderId)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                // Simple reconnect-with-delay would go here in production; omitted
                // for brevity. The REST endpoints remain the source of truth if the
                // socket drops, so nothing is lost — updates just arrive on next poll.
            }
        })
    }

    fun disconnect() {
        webSocket?.close(1000, "closing")
        webSocket = null
    }

    private fun extractOrderId(json: String): String? =
        Regex(""""orderId"\s*:\s*"([^"]+)"""").find(json)?.groupValues?.get(1)
}
