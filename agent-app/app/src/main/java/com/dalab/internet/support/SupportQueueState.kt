package com.dalab.internet.support

import com.dalab.internet.data.SupportConversation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * How many customers are currently waiting for a support agent (GET
 * /agent/support/queue returns exactly the queued+pending rows), for the
 * Home/More badge. Refreshed opportunistically alongside the notification
 * unread count (see AgentAlertsState) — whenever OrdersListScreen loads or
 * an order/support event arrives over the existing SSE stream — rather than
 * its own separate polling loop.
 */
object SupportQueueState {
    private val _waitingCount = MutableStateFlow(0)
    val waitingCount: StateFlow<Int> = _waitingCount.asStateFlow()

    fun update(queue: List<SupportConversation>) {
        _waitingCount.value = queue.size
    }
}
