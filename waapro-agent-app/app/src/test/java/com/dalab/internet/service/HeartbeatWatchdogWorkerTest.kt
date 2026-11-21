package com.dalab.internet.service

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure JVM unit tests for shouldRestartAgentService — the watchdog's
 * decision logic, with no Context/WorkManager/Service dependency. Covers
 * exactly the gap this function was added to close: a service that reports
 * running but whose heartbeatLoop coroutine has silently died (see
 * AgentBackgroundService/DalabAgentApp's own fix for that failure) must
 * still be detected and restarted, while a genuinely healthy service must
 * never be restarted just because the watchdog happened to tick.
 */
class HeartbeatWatchdogWorkerTest {
    private val now = 1_700_000_000_000L
    private val staleThresholdMs = HeartbeatWatchdogWorker.HEARTBEAT_STALE_THRESHOLD_MS

    @Test
    fun `restarts when the service is not running, regardless of heartbeat history`() {
        assertTrue(shouldRestartAgentService(isServiceRunning = false, lastHeartbeatSuccessAt = now, now = now, staleThresholdMs = staleThresholdMs))
        assertTrue(shouldRestartAgentService(isServiceRunning = false, lastHeartbeatSuccessAt = null, now = now, staleThresholdMs = staleThresholdMs))
    }

    @Test
    fun `restarts a service that reports running but has never recorded a successful heartbeat`() {
        assertTrue(shouldRestartAgentService(isServiceRunning = true, lastHeartbeatSuccessAt = null, now = now, staleThresholdMs = staleThresholdMs))
    }

    @Test
    fun `restarts a service that reports running but whose last heartbeat is past the stale threshold`() {
        val justOverThreshold = now - staleThresholdMs - 1
        assertTrue(shouldRestartAgentService(isServiceRunning = true, lastHeartbeatSuccessAt = justOverThreshold, now = now, staleThresholdMs = staleThresholdMs))
    }

    @Test
    fun `does not restart exactly at the threshold boundary, only once it is exceeded`() {
        val exactlyAtThreshold = now - staleThresholdMs
        assertFalse(shouldRestartAgentService(isServiceRunning = true, lastHeartbeatSuccessAt = exactlyAtThreshold, now = now, staleThresholdMs = staleThresholdMs))
    }

    @Test
    fun `does not restart a healthy service with a recent heartbeat`() {
        val oneNormalTickAgo = now - 60_000L
        assertFalse(shouldRestartAgentService(isServiceRunning = true, lastHeartbeatSuccessAt = oneNormalTickAgo, now = now, staleThresholdMs = staleThresholdMs))
    }

    @Test
    fun `does not restart a service whose heartbeat succeeded this very instant`() {
        assertFalse(shouldRestartAgentService(isServiceRunning = true, lastHeartbeatSuccessAt = now, now = now, staleThresholdMs = staleThresholdMs))
    }
}
