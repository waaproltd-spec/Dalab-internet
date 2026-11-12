package com.dalab.internet.auth

import com.dalab.internet.R

/**
 * The signed-in system's logo. Before sign-in (and for a system without its
 * own logo here yet) a neutral icon, so nothing on screen names a system
 * before the agent has signed in.
 */
object SystemBrand {
    fun logo(): Int = when (SystemSession.systemKey()) {
        "dalab" -> com.dalab.internet.auth.SystemBrand.logo()
        "danwadaag" -> R.drawable.danwadaag_logo
        else -> R.drawable.ic_notification
    }
}
