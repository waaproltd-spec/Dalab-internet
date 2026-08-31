package com.dalab.internet.notifications

import android.content.Context
import android.content.SharedPreferences
import com.dalab.internet.data.AgentNotification
import com.dalab.internet.util.parseApiDate
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Tracks how many admin-sent system notifications (GET /agent/notifications)
 * this device hasn't seen yet. The backend's `notifications` table has no
 * per-agent read state, so "unread" is purely local: whichever notification
 * was newest the last time the agent opened the Alerts screen becomes the
 * watermark, and anything newer than that counts as unread. Mirrors the
 * init(context)-guarded SharedPreferences pattern used by SmsListenerState.
 */
object AgentAlertsState {
    private const val PREFS = "dalab_agent_alerts"
    private const val KEY_LAST_SEEN_SENT_AT = "last_seen_sent_at"

    private lateinit var prefs: SharedPreferences

    private val _unreadCount = MutableStateFlow(0)
    val unreadCount: StateFlow<Int> = _unreadCount.asStateFlow()

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    /** Recomputes the badge count against the current watermark, without moving it. */
    fun updateUnreadCount(notifications: List<AgentNotification>) {
        val lastSeen = parseApiDate(prefs.getString(KEY_LAST_SEEN_SENT_AT, null))
        _unreadCount.value = if (lastSeen == null) {
            notifications.size
        } else {
            notifications.count { n -> parseApiDate(n.sentAt)?.after(lastSeen) == true }
        }
    }

    /**
     * Called when the agent actually views the list — moves the watermark
     * forward and clears the badge. Relies on the backend already returning
     * these ordered newest-first (GET /agent/notifications: ORDER BY sent_at
     * DESC), so the first entry is the new watermark.
     */
    fun markAllSeen(notifications: List<AgentNotification>) {
        val newest = notifications.firstOrNull()?.sentAt ?: return
        prefs.edit().putString(KEY_LAST_SEEN_SENT_AT, newest).apply()
        _unreadCount.value = 0
    }
}
