package com.dalab.internet.network

import com.dalab.internet.data.AgentNotice
import com.dalab.internet.data.AgentToday
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The agent's "Today" figures and the admin's Maintenance Notices, as last
 * read from the system. A failed read keeps the last good values (marked
 * stale) instead of showing zeros -- never fake numbers.
 */
object AgentDayRepository {
    private val _today = MutableStateFlow<AgentToday?>(null)
    val today: StateFlow<AgentToday?> = _today.asStateFlow()

    private val _todayStale = MutableStateFlow(false)
    /** True when the last refresh failed (offline): the numbers shown are older. */
    val todayStale: StateFlow<Boolean> = _todayStale.asStateFlow()

    private val _todayUpdatedAt = MutableStateFlow<Long?>(null)
    val todayUpdatedAt: StateFlow<Long?> = _todayUpdatedAt.asStateFlow()

    private val _notices = MutableStateFlow<List<AgentNotice>>(emptyList())
    val notices: StateFlow<List<AgentNotice>> = _notices.asStateFlow()

    suspend fun refreshToday() {
        try {
            val res = ApiClient.service.getAgentToday()
            val body = res.body()
            if (res.isSuccessful && body != null) {
                _today.value = body
                _todayStale.value = false
                _todayUpdatedAt.value = System.currentTimeMillis()
            } else {
                _todayStale.value = true
            }
        } catch (_: Exception) {
            _todayStale.value = true
        }
    }

    suspend fun refreshNotices() {
        try {
            val res = ApiClient.service.getAgentNotices()
            if (res.isSuccessful) _notices.value = res.body().orEmpty()
        } catch (_: Exception) {
            // Keep the last known notices while offline.
        }
    }

    suspend fun refreshAll() {
        refreshToday()
        refreshNotices()
    }

    /** Sign-out / system switch: forget the previous system's figures. */
    fun clear() {
        _today.value = null
        _notices.value = emptyList()
        _todayStale.value = false
        _todayUpdatedAt.value = null
    }
}
