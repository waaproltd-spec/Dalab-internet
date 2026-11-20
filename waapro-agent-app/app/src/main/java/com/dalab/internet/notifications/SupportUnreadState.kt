package com.dalab.internet.notifications

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Whether the Agent Support bottom tab should show its "new message" badge.
 *
 * Set the instant a support push arrives (AgentFcmService.onMessageReceived
 * -- covers both a fresh assignment and a customer's follow-up message, see
 * support.routes.ts's notifyAssignedAgent()/notifyAgentOfNewMessage(); either
 * way there's an unread customer message waiting) and once when the app is
 * opened with an already-assigned conversation waiting (MainActivity's
 * AgentHome -- covers a push that arrived while the app was backgrounded or
 * killed, which onMessageReceived never sees: the OS shows the system-tray
 * notification directly from the FCM payload in that case, bypassing this
 * class entirely).
 *
 * Cleared the instant the agent selects the Support tab.
 */
object SupportUnreadState {
    var hasUnread by mutableStateOf(false)
        private set

    fun markUnread() {
        hasUnread = true
    }

    fun clear() {
        hasUnread = false
    }
}
