package com.dalab.internet.queue

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Drives the "Offline -> Syncing -> Completed" indicator for agent-initiated
 * sales queued while this device had no connectivity (NewSaleScreen). Written
 * only by NewSaleScreen (the moment a sale is queued) and QueueDrainer (every
 * drain pass); read by any screen that wants to show the live status.
 */
object PendingSalesSyncStatus {
    enum class State { IDLE, OFFLINE, SYNCING, COMPLETED }

    private val _state = MutableStateFlow(State.IDLE)
    val state: StateFlow<State> = _state.asStateFlow()

    private val _pendingCount = MutableStateFlow(0)
    val pendingCount: StateFlow<Int> = _pendingCount.asStateFlow()

    private fun refreshCount() {
        _pendingCount.value = PendingActionQueue.all().count { it.type == PendingActionQueue.Type.SALE_CREATE }
    }

    /** Called the instant a sale is queued because the device is offline. */
    fun markQueued() {
        refreshCount()
        _state.value = State.OFFLINE
    }

    /** Called by QueueDrainer right before it attempts to replay any queued sales. */
    fun markSyncing() {
        refreshCount()
        _state.value = State.SYNCING
    }

    /** Called by QueueDrainer after a drain pass — reflects whatever's left. */
    fun markDrainResult() {
        refreshCount()
        _state.value = if (_pendingCount.value == 0) State.COMPLETED else State.OFFLINE
    }
}
