package com.dalab.internet.customer.notifications

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.dalab.internet.customer.data.NotificationItem
import com.dalab.internet.customer.network.ApiClient

/**
 * Proactive fallback for customers who never get a real push (no
 * google-services.json yet, a stale/unregistered FCM token, or push simply
 * failing) -- an unread count on the Home bell icon that updates on its own
 * (login, Home, and every app resume), rather than requiring the customer to
 * think to open Notifications and check.
 *
 * "Unread" is tracked purely client-side, against a locally persisted
 * last-seen timestamp -- there's no read/unread column on the backend's
 * `notifications` table, and adding one would mean touching schema/business
 * logic this task explicitly stays out of. sentAt is an ISO-8601 UTC string
 * (Postgres timestamptz serialized by the backend), so plain string
 * comparison already sorts chronologically correctly -- no date parsing
 * needed.
 */
object NotificationsBadgeState {
    private const val PREFS = "dalab_customer_notification_badge"
    private const val KEY_LAST_SEEN_AT = "last_seen_at"

    private lateinit var prefs: SharedPreferences
    private var lastSeenAt: String?
        get() = prefs.getString(KEY_LAST_SEEN_AT, null)
        set(value) { prefs.edit().putString(KEY_LAST_SEEN_AT, value).apply() }

    var unreadCount by mutableStateOf(0)
        private set

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    /** Re-fetches the inbox and recomputes the unread count against the last
     * time the customer actually opened Notifications. Safe to call
     * repeatedly (Home arrival, every Activity resume) -- failures are
     * silent, same best-effort spirit as the rest of the push pipeline. */
    suspend fun refresh() {
        try {
            val notifications = ApiClient.service.getNotifications().body().orEmpty()
            val seen = lastSeenAt
            unreadCount = if (seen == null) notifications.size else notifications.count { it.sentAt > seen }
        } catch (_: Exception) {
            // Leave the count as-is; the next successful refresh will catch up.
        }
    }

    /** A push arrived while the app was in the foreground -- bump the badge
     * immediately rather than waiting for the next refresh, for a UI that
     * feels live. The next real refresh() reconciles this against the
     * server's actual count either way. */
    fun bumpForIncomingPush() {
        unreadCount += 1
    }

    /** Called once NotificationsScreen has actually loaded the list --
     * opening the inbox is what "read" means here. */
    fun markAllSeen(notifications: List<NotificationItem>) {
        val latest = notifications.maxByOrNull { it.sentAt }?.sentAt
        if (latest != null) lastSeenAt = latest
        unreadCount = 0
    }
}
