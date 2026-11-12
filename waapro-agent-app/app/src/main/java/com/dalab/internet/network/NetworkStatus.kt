package com.dalab.internet.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Is this phone online? Drives the connection banner and "refresh
 * everything" after the internet comes back. Reconnecting never dials
 * anything: saved USSD results are sent by QueueDrainer (as before), and
 * an uncertain transaction is only ever shown for a person to check.
 */
object NetworkStatus {
    private val _online = MutableStateFlow(true)
    val online: StateFlow<Boolean> = _online.asStateFlow()

    private val _reconnected = MutableSharedFlow<Long>(extraBufferCapacity = 4)
    /** Emits (the time) each time the phone comes back online after being offline. */
    val reconnected: SharedFlow<Long> = _reconnected.asSharedFlow()

    private val _lastOfflineAt = MutableStateFlow<Long?>(null)
    val lastOfflineAt: StateFlow<Long?> = _lastOfflineAt.asStateFlow()

    @Volatile private var registered = false

    fun init(context: Context) {
        if (registered) return
        val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        set(isOnline(cm))
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = set(isOnline(cm))
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) =
                set(caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
            override fun onLost(network: Network) = set(isOnline(cm))
        })
        registered = true
    }

    private fun isOnline(cm: ConnectivityManager): Boolean {
        val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) } ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /** Pure transition logic, exposed for tests. */
    internal fun set(nowOnline: Boolean, atMs: Long = System.currentTimeMillis()) {
        val was = _online.value
        if (was == nowOnline) return
        _online.value = nowOnline
        if (!nowOnline) _lastOfflineAt.value = atMs else _reconnected.tryEmit(atMs)
    }
}
