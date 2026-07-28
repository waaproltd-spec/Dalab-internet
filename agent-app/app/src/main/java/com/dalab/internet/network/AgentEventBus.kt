package com.dalab.internet.network

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Decouples the SSE connection's lifecycle from whichever screen happens to
 * be on-screen. [AgentBackgroundService] owns the single [RealtimeClient]
 * connection and emits here on every order event; any composable (currently
 * OrdersListScreen) just collects [orderEvents] instead of opening its own
 * connection, so live updates keep arriving even while the agent is on a
 * different tab or the screen is locked. [connectionState] mirrors that same
 * RealtimeClient's [ConnectionState] so a screen can show a real
 * Connected/Disconnected/Reconnecting indicator instead of only a passive
 * "last synced" timestamp.
 */
object AgentEventBus {
    private val _orderEvents = MutableSharedFlow<Unit>(extraBufferCapacity = 8)
    val orderEvents: SharedFlow<Unit> = _orderEvents.asSharedFlow()

    private val _connectionState = MutableStateFlow(ConnectionState.CONNECTING)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    // Emitted the moment ApiClient's token-refresh Authenticator gives up and
    // clears the session in the background (refresh token expired/revoked).
    // Nothing prompted the agent to notice this before — every subsequent
    // SMS upload/verify/dial call just silently 401'd forever until they
    // happened to reopen the app. AgentBackgroundService collects this to
    // post a real notification instead.
    private val _sessionExpired = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val sessionExpired: SharedFlow<Unit> = _sessionExpired.asSharedFlow()

    fun emitOrderEvent() {
        _orderEvents.tryEmit(Unit)
    }

    fun setConnectionState(state: ConnectionState) {
        _connectionState.value = state
    }

    fun emitSessionExpired() {
        _sessionExpired.tryEmit(Unit)
    }
}
