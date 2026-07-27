package com.dalab.internet.customer.queue

import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.CreateOrderRequest

/** Gson-serialized payload for a queued order-creation attempt. */
data class OrderCreateAction(val request: CreateOrderRequest)

/**
 * Replays queued order-creation attempts against the backend — invoked from
 * MainActivity both on a connectivity-restored callback and on resume, since
 * this app (deliberately, unlike the Agent App) has no background service:
 * a queued order isn't time-critical the way a missed agent-side payment
 * match is, and the moment the customer reopens the app the queue drains.
 */
object QueueDrainer {

    suspend fun drainAll() {
        for (action in PendingActionQueue.all()) {
            drainOne(action)
        }
    }

    private suspend fun drainOne(action: PendingActionQueue.PendingAction) {
        if (action.type != PendingActionQueue.Type.ORDER_CREATE) return
        val payload = PendingActionQueue.payloadOf<OrderCreateAction>(action)
        try {
            // clientRequestId (set when this was first enqueued) makes this
            // safe to replay even if the original attempt actually reached
            // the server before the app detected the connectivity drop.
            RetryClassifier.requireSuccessful(ApiClient.service.createOrder(payload.request))
            PendingActionQueue.remove(action.id)
        } catch (e: Exception) {
            if (RetryClassifier.isRetryable(e)) {
                PendingActionQueue.markAttempt(action.id, e.message)
            } else {
                PendingActionQueue.remove(action.id) // rejected — will never succeed
            }
        }
    }
}
