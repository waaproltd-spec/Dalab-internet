package com.dalab.internet.network

import okhttp3.Dns
import java.net.Inet4Address
import java.net.InetAddress

/**
 * Tries a server's IPv4 addresses before its IPv6 ones.
 *
 * OkHttp 4 tries a host's addresses one after another, waiting the full
 * connect timeout on each. On a Wi-Fi that hands out IPv6 but can't reach
 * the internet over it, every request first waited on the IPv6 address
 * ("Signing in..." for up to a minute, or never arriving) while the
 * phone's browser, which races both, opened the same site instantly.
 * IPv6 stays as the fallback, so an IPv6-only network still works.
 */
object Ipv4FirstDns : Dns {
    override fun lookup(hostname: String): List<InetAddress> =
        sortIpv4First(Dns.SYSTEM.lookup(hostname))

    internal fun sortIpv4First(addresses: List<InetAddress>): List<InetAddress> =
        addresses.sortedBy { if (it is Inet4Address) 0 else 1 }
}
