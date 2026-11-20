package com.dalab.internet.network

import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.InetAddress

class Ipv4FirstDnsTest {
    @Test fun ipv4ComesBeforeIpv6AndNothingIsDropped() {
        val v6 = InetAddress.getByName("2001:db8::1")
        val v4a = InetAddress.getByName("203.0.113.7")
        val v4b = InetAddress.getByName("198.51.100.2")
        val sorted = Ipv4FirstDns.sortIpv4First(listOf(v6, v4a, v4b))
        assertEquals(listOf(v4a, v4b, v6), sorted)
    }
}
