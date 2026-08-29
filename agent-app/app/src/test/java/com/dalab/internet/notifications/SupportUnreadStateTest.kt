package com.dalab.internet.notifications

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SupportUnreadStateTest {

    // hasUnread is a shared, process-wide object -- reset it before each
    // test so one test's markUnread() can't leak into the next.
    @Before
    fun reset() {
        SupportUnreadState.clear()
    }

    @Test
    fun `starts cleared`() {
        assertFalse(SupportUnreadState.hasUnread)
    }

    @Test
    fun `markUnread sets the flag`() {
        SupportUnreadState.markUnread()
        assertTrue(SupportUnreadState.hasUnread)
    }

    @Test
    fun `clear resets the flag`() {
        SupportUnreadState.markUnread()
        SupportUnreadState.clear()
        assertFalse(SupportUnreadState.hasUnread)
    }

    @Test
    fun `markUnread is idempotent -- calling it twice is still just unread`() {
        SupportUnreadState.markUnread()
        SupportUnreadState.markUnread()
        assertTrue(SupportUnreadState.hasUnread)
    }
}
