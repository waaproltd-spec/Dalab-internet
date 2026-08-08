package com.dalab.internet.customer.util

import android.content.Intent
import android.net.Uri

/**
 * Builds the "Dial to Pay" USSD string for a Money Exchange order's
 * collection-payment leg — the customer paying INTO DALAB's collection
 * wallet, analogous to [PaymentDialUtil] for Internet Store, but
 * deliberately NOT reusing PaymentDialUtil's "%.2f" decimal format.
 *
 * "." is not a valid GSM/USSD MMI dial character (digits, *, # only) — a
 * decimal amount embedded directly in a dial string never reaches the
 * carrier intact, confirmed live against the real payout flow (see
 * admin-backend-ts's ussdAmountSegments()): "1.98" was flattened into "198"
 * every time, a 100x error. The carrier's own Dial-to-Pay menu instead
 * expects the amount as two separate *-delimited segments, whole dollars
 * then cents. Since this collection leg dials the exact same carrier menus,
 * it carries the exact same risk — segmented here from the start rather
 * than repeating the bug in a new code path.
 */
object ExchangeDialUtil {
    fun resolveDialIntent(dialPrefix: String, collectionPhoneNumber: String, amount: Double): Intent {
        val cents = Math.round(amount * 100)
        val dollars = cents / 100
        val remainderCents = cents % 100
        val dialTarget = "*$dialPrefix*$collectionPhoneNumber*$dollars*${remainderCents.toString().padStart(2, '0')}#"
        return Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(dialTarget)))
    }
}
