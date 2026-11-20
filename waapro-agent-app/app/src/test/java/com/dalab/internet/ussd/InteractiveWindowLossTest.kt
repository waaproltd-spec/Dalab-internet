package com.dalab.internet.ussd

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The carrier dialog disappears for a moment between two menu screens, and
 * for good after the final receipt. Neither is a lost window: treating them
 * as one pulled the agent app over the USSD flow on every step and kept the
 * phone busy right when the app froze. Only a sustained absence while a
 * reply is still owed counts.
 */
class InteractiveWindowLossTest {
    private val t0 = 1_800_000_000_000L

    @Test fun `a short gap between two carrier screens is not a lost window`() {
        assertFalse(isWindowLost(t0, t0 + 500, stage = 1, totalReplies = 3))
        assertFalse(isWindowLost(t0, t0 + WINDOW_LOST_GRACE_MS - 1, stage = 1, totalReplies = 3))
    }

    @Test fun `a window gone for the whole grace period while a reply is owed is lost`() {
        assertTrue(isWindowLost(t0, t0 + WINDOW_LOST_GRACE_MS, stage = 0, totalReplies = 3))
        assertTrue(isWindowLost(t0, t0 + 10_000, stage = 2, totalReplies = 3))
    }

    @Test fun `the dialog closing after every reply was sent is the normal end, never lost`() {
        assertFalse(isWindowLost(t0, t0 + 60_000, stage = 3, totalReplies = 3))
    }

    @Test fun `a window that is on screen is never lost`() {
        assertFalse(isWindowLost(null, t0, stage = 0, totalReplies = 3))
    }
}
