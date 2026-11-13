package com.dalab.internet.auth

import com.dalab.internet.R

/**
 * The logo shown everywhere in the app: the official WAAPRO LTD logo
 * (res/drawable/waapro_ltd_logo.png, unchanged). The same for every
 * system's agents (DALAB, Danwadaag, Fududeeye, Sahal), before and after
 * sign-in; no system's own logo is shown.
 */
object SystemBrand {
    fun logo(): Int = R.drawable.waapro_ltd_logo
}
