package com.dalab.internet.auth

import com.dalab.internet.R

/**
 * The signed-in system's logo. Before sign-in (and for a system without its
 * own logo here yet) the WAAPRO LTD logo, the company behind every system,
 * so nothing on screen names a system before the agent has signed in.
 */
object SystemBrand {
    fun logo(): Int = when (SystemSession.systemKey()) {
        "dalab" -> R.drawable.dalab_logo
        "danwadaag" -> R.drawable.danwadaag_logo
        else -> R.drawable.waapro_ltd_logo
    }
}
