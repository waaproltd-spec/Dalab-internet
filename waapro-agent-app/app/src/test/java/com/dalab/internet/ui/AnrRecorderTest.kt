package com.dalab.internet.ui

import com.dalab.internet.diagnostics.AnrRecorder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AnrRecorderTest {
    @Test fun keepsOnlyTheMainThread() {
        val dump = "----- pid 1 -----\n\n\"main\" prio=5 tid=1 Blocked\n  at a.B.c(B.kt:10)\n\n\"other\" prio=5\n  at x.Y.z(Y.kt:1)\n"
        val part = AnrRecorder.mainThreadPart(dump)
        assertTrue(part.startsWith("\"main\""))
        assertTrue(part.contains("B.kt:10"))
        assertTrue(!part.contains("Y.kt"))
    }

    @Test fun fallsBackToTheStartWithoutAMainThread() {
        assertEquals("abc", AnrRecorder.mainThreadPart("abc"))
    }
}
