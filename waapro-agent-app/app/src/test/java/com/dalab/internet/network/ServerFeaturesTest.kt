package com.dalab.internet.network

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** A system without Reseller Withdraw answers 404: the app stops asking
 * every minute, logs it once, and checks again after an hour. */
class ServerFeaturesTest {
    @Before
    fun clean() = ServerFeatures.reset()

    @Test
    fun `a 404 skips the feature, logged once, until the hourly re-check`() {
        val f = ServerFeatures.RESELLER_WITHDRAW
        assertFalse(ServerFeatures.isSkipped(f, now = 0L))
        assertTrue("first 404 is logged", ServerFeatures.markMissing(f, now = 1_000L))
        assertFalse("a repeat 404 isn't logged again", ServerFeatures.markMissing(f, now = 2_000L))
        assertTrue(ServerFeatures.isSkipped(f, now = 2_000L + 60_000L))
        assertFalse("checked again after an hour", ServerFeatures.isSkipped(f, now = 2_000L + ServerFeatures.RECHECK_MS))
    }

    @Test
    fun `signing in (another system) forgets what was missing`() {
        ServerFeatures.markMissing(ServerFeatures.RESELLER_WITHDRAW, now = 0L)
        ServerFeatures.reset()
        assertFalse(ServerFeatures.isSkipped(ServerFeatures.RESELLER_WITHDRAW, now = 10L))
    }
}
