package com.dalab.internet.ussd

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.SubscriptionManager
import com.dalab.internet.diagnostics.DiagnosticsLog

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

    /** Maps a telephony subscription id to the PhoneAccountHandle ACTION_CALL
     * needs to route to a specific SIM on a dual-SIM device. Prefers Android's
     * official [SubscriptionManager.getSubscriptionId] (API 30+), which reads
     * the real subscription a handle belongs to directly. Falls back to the
     * previous string-matching heuristic (assumes a handle's own id string
     * equals the subscription id -- a widely-used but undocumented
     * convention, not a guaranteed public API) below API 30 or if the
     * official lookup finds no match. Confirmed live as a real gap, not just
     * theoretical: every observed eDahab -> EVC Plus payout failure's
     * exchange_window_search_miss diagnostics found com.android.systemui
     * windows but never com.android.phone -- consistent with the string
     * heuristic silently failing to match that corridor's SIM, so ACTION_CALL
     * went out with no PhoneAccountHandle extra at all and fell through to
     * Android's own SIM-picker system dialog instead of the carrier's USSD
     * reply dialog, which ExchangeUssdAccessibilityService was never built to
     * detect or dismiss. Returns null (Android uses its currently-default
     * SIM/asks the user) only if neither method resolves -- same
     * platform-fragmentation caveat UssdDialer already carries for Internet
     * Store's dual-SIM routing, which this never touches. */
    private fun resolvePhoneAccountHandle(subscriptionId: Int): PhoneAccountHandle? {
        return try {
            val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager ?: return null
            val handles = telecomManager.callCapablePhoneAccounts

            // Wrapped in its own try so any failure here (unexpected on an OEM
            // that's already passed hasRequiredPermissions(), but not worth
            // trusting blindly) falls through to the string-matching fallback
            // below rather than skipping it -- this lookup must only ever add
            // a better match, never remove the existing coverage.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val officialMatch = try {
                    val subscriptionManager = context.getSystemService(SubscriptionManager::class.java)
                    handles.firstOrNull { handle -> subscriptionManager?.getSubscriptionId(handle) == subscriptionId }
                } catch (_: SecurityException) {
                    null
                }
                if (officialMatch != null) {
                    DiagnosticsLog.record(
                        "exchange_phone_account_resolution",
                        "subscriptionId=$subscriptionId resolved to a PhoneAccountHandle via the official SubscriptionManager API.",
                        isError = false,
                    )
                    return officialMatch
                }
            }

            val fallbackMatch = handles.firstOrNull { handle -> handle.id == subscriptionId.toString() }
            DiagnosticsLog.record(
                "exchange_phone_account_resolution",
                if (fallbackMatch != null) {
                    "subscriptionId=$subscriptionId resolved to a PhoneAccountHandle via the string-matching fallback (official API unavailable or found no match)."
                } else {
                    "subscriptionId=$subscriptionId could not be resolved to any PhoneAccountHandle among ${handles.size} call-capable account(s) -- ACTION_CALL will fall through to the OS's default SIM/chooser."
                },
                isError = fallbackMatch == null,
            )
            fallbackMatch
        } catch (_: SecurityException) {
            null
        }
    }
}
