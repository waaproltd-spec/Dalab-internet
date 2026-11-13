package com.dalab.internet.ussd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The Agent App waits while the phone's owner uses USSD, the dialer or a call. */
class PhoneBusyMonitorTest {
    private val own = "com.waaproltd.agent"
    private fun kind(pkg: String?, cls: String? = null) = PhoneBusyMonitor.classify(pkg, cls, own)

    @Test
    fun `recognises USSD windows, dialers and neutral system windows`() {
        assertEquals(PhoneBusyMonitor.WindowKind.USSD_DIALOG, kind("com.android.phone", "android.app.AlertDialog"))
        assertEquals(PhoneBusyMonitor.WindowKind.USSD_DIALOG, kind("com.samsung.android.app.telephonyui", "x"))
        assertEquals(PhoneBusyMonitor.WindowKind.USSD_DIALOG, kind("com.oem.phone", "com.oem.UssdAlertActivity"))
        assertEquals(PhoneBusyMonitor.WindowKind.DIALER, kind("com.google.android.dialer"))
        assertEquals(PhoneBusyMonitor.WindowKind.DIALER, kind("com.samsung.android.dialer"))
        assertEquals(PhoneBusyMonitor.WindowKind.DIALER, kind("com.android.incallui"))
        assertEquals(PhoneBusyMonitor.WindowKind.NEUTRAL, kind("com.android.systemui"))
        assertEquals(PhoneBusyMonitor.WindowKind.NEUTRAL, kind("com.google.android.inputmethod.latin"))
        assertEquals(PhoneBusyMonitor.WindowKind.OTHER, kind("com.whatsapp"))
        assertEquals(PhoneBusyMonitor.WindowKind.OTHER, kind(own))
    }

    @Test
    fun `busy while a call, a manual USSD or the dialer is open, then a quiet pause`() {
        val now = 1_000_000L
        assertEquals("a phone call", PhoneBusyMonitor.busyReason(null, null, inCall = true, lastBusyEndedAt = 0L, now = now))
        assertEquals("a USSD session", PhoneBusyMonitor.busyReason(now - 5_000, null, false, 0L, now))
        assertEquals("the phone dialer", PhoneBusyMonitor.busyReason(null, now - 5_000, false, 0L, now))
        assertEquals("the phone was just used", PhoneBusyMonitor.busyReason(null, null, false, now - 3_000, now))
        assertNull(PhoneBusyMonitor.busyReason(null, null, false, now - PhoneBusyMonitor.QUIET_MS, now))
    }

    @Test
    fun `a forgotten dialer or USSD window can't hold payments forever, a call always counts`() {
        val now = 10_000_000L
        assertNull(PhoneBusyMonitor.busyReason(null, now - PhoneBusyMonitor.MAX_DIALER_MS, false, 0L, now))
        assertNull(PhoneBusyMonitor.busyReason(now - PhoneBusyMonitor.MAX_USSD_MS, null, false, 0L, now))
        assertEquals("a phone call", PhoneBusyMonitor.busyReason(null, null, true, 0L, now))
    }

    @Test
    fun `window changes - owner's USSD sets busy, leaving to another app starts the quiet pause`() {
        PhoneBusyMonitor.resetForTest()
        UssdSimLock.phoneFreeGate = null
        val t = 50_000_000L
        assertNull(PhoneBusyMonitor.reasonNow(t))
        PhoneBusyMonitor.onWindowChanged("com.android.phone", "AlertDialog", own, now = t)
        assertEquals("a USSD session", PhoneBusyMonitor.reasonNow(t + 1_000))
        PhoneBusyMonitor.onWindowChanged("com.android.systemui", null, own, now = t + 2_000) // shade: no change
        assertEquals("a USSD session", PhoneBusyMonitor.reasonNow(t + 2_500))
        PhoneBusyMonitor.onWindowChanged("com.whatsapp", null, own, now = t + 3_000) // owner left the USSD
        assertEquals("the phone was just used", PhoneBusyMonitor.reasonNow(t + 4_000))
        assertNull(PhoneBusyMonitor.reasonNow(t + 3_000 + PhoneBusyMonitor.QUIET_MS))
        PhoneBusyMonitor.onWindowChanged("com.google.android.dialer", null, own, now = t + 20_000)
        assertEquals("the phone dialer", PhoneBusyMonitor.reasonNow(t + 21_000))
        PhoneBusyMonitor.resetForTest()
    }
}
