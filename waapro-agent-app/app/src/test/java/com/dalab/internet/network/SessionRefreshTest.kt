package com.dalab.internet.network

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Agents stay signed in: only the server's explicit refusal of the
 * renewal key signs them out -- never a network problem. */
class SessionRefreshTest {
    @Test
    fun `no signal, timeouts and server errors keep the agent signed in`() {
        assertFalse("no answer at all (no signal / timeout)", refreshFailureEndsSession(null))
        for (code in listOf(500, 502, 503, 504, 408, 429)) {
            assertFalse("HTTP $code must not sign the agent out", refreshFailureEndsSession(code))
        }
    }

    @Test
    fun `the server refusing the key signs the agent out`() {
        assertTrue(refreshFailureEndsSession(401))
        assertTrue(refreshFailureEndsSession(403))
    }
}
