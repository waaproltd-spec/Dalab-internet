package com.dalab.internet.ussd

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.telecom.TelecomManager

/**
 * Money Exchange's dial primitive — deliberately NOT UssdDialer.dial().
 * Internet Store's sendUssdRequest() takes ownership of the USSD session end
 * to end and never shows Android's own reply dialog, so there is nothing for
 * ExchangeUssdAccessibilityService to read. Dialing via ACTION_CALL instead
 * routes the USSD code through Android's normal telephony/dialer handling,
 * which DOES surface the native "USSD message" reply dialog — the thing the
 * accessibility service drives through the two-step (number+amount, then
 * PIN) flow. Reuses the CALL_PHONE permission Internet Store's UssdDialer
 * already requires — no new dangerous-permission prompt needed for this.
 */
class ExchangeUssdDialer(private val context: Context) {

    fun hasRequiredPermissions(): Boolean = UssdDialer(context).hasRequiredPermissions()

    fun subscriptionIdForSlot(oneBasedSlot: Int): SubscriptionLookupResult =
        UssdDialer(context).subscriptionIdForSlot(oneBasedSlot)

    /** Triggers the OS's own USSD dial for [ussdCode] on the SIM identified
     * by [subscriptionId]. Does not wait for or read any response itself —
     * that's ExchangeUssdBridge/ExchangeUssdAccessibilityService's job. */
    fun dial(subscriptionId: Int, ussdCode: String) {
        val intent = Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(ussdCode))).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            resolvePhoneAccountHandle(subscriptionId)?.let {
                putExtra(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, it)
            }
        }
        context.startActivity(intent)
    }

    /** Best-effort mapping from a telephony subscription id to the
     * PhoneAccountHandle ACTION_CALL needs to route to a specific SIM on a
     * dual-SIM device. On AOSP-derived telephony stacks the handle's own id
     * string equals the subscription id; this is a widely-used but
     * undocumented convention, not a guaranteed public API — falls back to
     * null (Android uses its currently-default SIM/asks the user) if it
     * can't be resolved on a given OEM, same platform-fragmentation caveat
     * UssdDialer already carries for Internet Store's dual-SIM routing. */
    private fun resolvePhoneAccountHandle(subscriptionId: Int): android.telecom.PhoneAccountHandle? {
        return try {
            val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager ?: return null
            telecomManager.callCapablePhoneAccounts.firstOrNull { handle -> handle.id == subscriptionId.toString() }
        } catch (_: SecurityException) {
            null
        }
    }
}
