package com.dalab.internet.network

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * Decouples the SSE connection's lifecycle from whichever screen happens to
 * be on-screen. [AgentBackgroundService] owns the single [RealtimeClient]
 * connection and emits here on every order event; any composable (currently
 * OrdersListScreen) just collects [orderEvents] instead of opening its own
 * connection, so live updates keep arriving even while the agent is on a
 * different tab or the screen is locked.
 */
object AgentEventBus {
    private val _orderEvents = MutableSharedFlow<Unit>(extraBufferCapacity = 8)
    val orderEvents: SharedFlow<Unit> = _orderEvents.asSharedFlow()

    fun emitOrderEvent() {
        _orderEvents.tryEmit(Unit)
    }
}
