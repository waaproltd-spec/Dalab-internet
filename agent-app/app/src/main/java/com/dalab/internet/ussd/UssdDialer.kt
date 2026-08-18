package com.dalab.internet.ussd

import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import android.Manifest
import android.content.pm.PackageManager
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Real dual-SIM USSD execution using Android's actual public API for this —
 * TelephonyManager.sendUssdRequest() (API 26+). This is not a workaround or
 * an accessibility-service hack; it's the documented, non-root mechanism
 * Android provides for an app to send a USSD request and receive the
 * response programmatically.
 *
 * HONEST LIMITATION, stated here rather than left implicit: this API
 * genuinely works on stock/AOSP-close Android, but several major OEMs
 * (Samsung, Xiaomi, Huawei, and others at various points) apply carrier/
 * manufacturer customizations that force a visible system USSD dialog or
 * silently drop the callback, regardless of what this app does. This is a
 * widely-documented constraint in mobile-money-automation apps across East
 * Africa specifically — not something unique to this implementation, and
 * not something any app can bypass without root. Test on your actual target
 * devices before assuming silent execution; build UI (see
 * SmsPermissionScreen-style screens) that tells the agent to check the
 * phone if a dial attempt times out, rather than promising it never will.
 */
class UssdDialer(private val context: Context) {

    fun hasRequiredPermissions(): Boolean {
        val callPhone = ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE)
        val readPhoneState = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE)
        return callPhone == PackageManager.PERMISSION_GRANTED && readPhoneState == PackageManager.PERMISSION_GRANTED
    }

    /** Lists the SIMs actually inserted right now, for the SIM Routing Setup screen to show real carrier names. */
    fun listActiveSims(): List<DeviceSimSlot> {
        if (!hasRequiredPermissions()) return emptyList()
        val subscriptionManager = context.getSystemService(SubscriptionManager::class.java) ?: return emptyList()
        val infos = try {
            subscriptionManager.activeSubscriptionInfoList
        } catch (_: SecurityException) {
            null
        } ?: return emptyList()

        return infos.map {
            DeviceSimSlot(
                subscriptionId = it.subscriptionId,
                simSlotIndex = it.simSlotIndex,
                carrierName = it.carrierName?.toString() ?: it.displayName?.toString() ?: "SIM ${it.simSlotIndex + 1}",
            )
        }
    }

    /**
     * Resolves the Super Admin's 1-based "SIM 1 / SIM 2" configuration to an
     * actual device subscription id. `listActiveSims()` silently returns an
     * empty list when CALL_PHONE/READ_PHONE_STATE isn't granted — indistinguishable
     * from a genuinely empty SIM tray unless checked separately here, which
     * previously meant a lost permission and a missing SIM produced the exact
     * same "isn't physically inserted" message with no way to tell them apart.
     */
    fun subscriptionIdForSlot(oneBasedSlot: Int): SubscriptionLookupResult {
        if (!hasRequiredPermissions()) return SubscriptionLookupResult.PermissionMissing
        val targetIndex = oneBasedSlot - 1 // Android's simSlotIndex is 0-based
        val subscriptionId = listActiveSims().firstOrNull { it.simSlotIndex == targetIndex }?.subscriptionId
        return subscriptionId?.let { SubscriptionLookupResult.Found(it) } ?: SubscriptionLookupResult.NotPresent
    }

    /**
     * Sends the USSD request on the given SIM and suspends until a response,
     * error, or timeout. Requires API 26+ (sendUssdRequest itself requires
     * it); callers on lower API levels should treat this feature as
     * unavailable rather than crash — see MainActivity's Build.VERSION check.
     */
    @RequiresApi(Build.VERSION_CODES.O)
    suspend fun dial(
        subscriptionId: Int,
        ussdCode: String,
        timeoutMs: Long = 30_000,
        // Defaults to the exact classification every existing caller
        // (Internet Store's UssdOrchestrator) has always used — a caller
        // that doesn't pass this is byte-for-byte unaffected. Reseller
        // Withdraw passes its own stricter three-way classifier (see
        // classifyResellerWithdrawalUssdResponse below) instead of forking
        // this whole function.
        classify: (String) -> DialOutcome = { text -> if (looksLikeFailureResponse(text)) DialOutcome.AMBIGUOUS else DialOutcome.SUCCESS },
    ): DialResult {
        if (!hasRequiredPermissions()) return DialResult(DialOutcome.PERMISSION_DENIED)

        val baseManager = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        val simManager = baseManager.createForSubscriptionId(subscriptionId)

        // A USSD round-trip (dial -> carrier -> callback) can take several
        // seconds and must not be cut short by the device going to sleep
        // mid-request — this is exactly the "critical background task" a
        // partial wake lock exists for. Scoped tightly to this single dial
        // (acquired just before sending, released the moment it resumes) and
        // backstopped with its own timeout equal to the dial timeout, so a
        // bug here can never hold it indefinitely even if release() were
        // somehow skipped.
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DalabAgent:UssdDial")
        wakeLock?.acquire(timeoutMs + 5_000)

        try {
            return suspendCancellableCoroutine { continuation ->
                var resumed = false
                val handler = android.os.Handler(context.mainLooper)

                val timeoutRunnable = Runnable {
                    if (!resumed) {
                        resumed = true
                        continuation.resume(DialResult(DialOutcome.TIMEOUT))
                    }
                }
                handler.postDelayed(timeoutRunnable, timeoutMs)

                val callback = object : TelephonyManager.UssdResponseCallback() {
                    override fun onReceiveUssdResponse(telephonyManager: TelephonyManager, request: String, response: CharSequence) {
                        if (resumed) return
                        resumed = true
                        handler.removeCallbacks(timeoutRunnable)
                        val text = response.toString()
                        // onReceiveUssdResponse firing only means the OS got SOME
                        // text back from the carrier — it says nothing about
                        // whether that text actually confirms the top-up. A
                        // carrier response reading e.g. "insufficient balance" or
                        // a generic timeout/error message triggers this exact
                        // callback the same as a genuine success message would,
                        // so it must not be treated as SUCCESS without checking
                        // the text itself.
                        val outcome = classify(text)
                        continuation.resume(DialResult(outcome, text))
                    }

                    override fun onReceiveUssdResponseFailed(telephonyManager: TelephonyManager, request: String, failureCode: Int) {
                        if (resumed) return
                        resumed = true
                        handler.removeCallbacks(timeoutRunnable)
                        continuation.resume(DialResult(DialOutcome.FAILED, "USSD failure code: $failureCode"))
                    }
                }

                try {
                    simManager.sendUssdRequest(ussdCode, callback, handler)
                } catch (e: SecurityException) {
                    if (!resumed) {
                        resumed = true
                        handler.removeCallbacks(timeoutRunnable)
                        continuation.resume(DialResult(DialOutcome.PERMISSION_DENIED, e.message))
                    }
                }

                continuation.invokeOnCancellation { handler.removeCallbacks(timeoutRunnable) }
            }
        } finally {
            if (wakeLock?.isHeld == true) wakeLock.release()
        }
    }
}

/**
 * Cheap, deliberately conservative check: does this USSD response text read
 * like a failure/error/timeout rather than a genuine top-up confirmation?
 * NOT exhaustive (no confirmed real "success" vs "failure" sample text was
 * available when this was written — same caveat as
 * SmsReceiver.PAYMENT_LOOKING_KEYWORDS) — this is a negative filter, not a
 * positive-match allowlist, so it only ever downgrades a response that
 * contains one of these red flags; it can never misclassify a genuine
 * confirmation it hasn't seen the wording of. Expand this list as real
 * ambiguous/failure responses are observed in production (see the Payment
 * History dial-attempt log, which now records every AMBIGUOUS response's raw
 * text for exactly this purpose). Blank/empty text is also treated as
 * ambiguous — a real confirmation always has some content.
 */
private val FAILURE_RESPONSE_KEYWORDS = listOf(
    "error", "fail", "timeout", "timed out", "invalid", "incorrect",
    "insufficient", "try again", "unable", "sorry", "declined", "cancelled",
    "canceled", "expired", "denied", "not available", "busy", "khalad",
    // Somali insufficient-balance phrasing, confirmed live from a real
    // Reseller Withdraw payout dial (Hormuud): "Haraaga xisaabtaadu kuguma
    // filna, haraagaagu waa: 5.367" ("your account balance is not
    // sufficient for it, your balance is: 5.367") — this response was
    // previously misclassified SUCCESS because no Somali failure phrasing
    // beyond "khalad" was in this list, which silently stranded that
    // withdrawal at 'sent' forever (a false-success dial attempt blocks the
    // self-heal sweeper from ever retrying it). "kuguma filna"/"kuma filna"
    // is the negated form of "filan" (sufficient/enough) Hormuud's USSD
    // responses use specifically for insufficient balance.
    "kuguma filna", "kuma filna",
    // Also confirmed live: "Receiver Account Not Found" (English) for a
    // destination number Hormuud doesn't recognize as a registered account
    // — "not available" didn't cover this since the wording is "not found",
    // not "not available". Same false-SUCCESS/stranded-withdrawal failure
    // mode as the Somali phrasing above.
    "not found",
)

fun looksLikeFailureResponse(text: String): Boolean {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return true
    val lower = trimmed.lowercase()
    return FAILURE_RESPONSE_KEYWORDS.any { lower.contains(it) }
}

/**
 * Reseller Withdraw's OWN response classifier — three-way (SUCCESS/FAILED/
 * AMBIGUOUS), deliberately stricter than [looksLikeFailureResponse]'s
 * default-to-SUCCESS design above (which stays exactly as-is for Internet
 * Store recharge — this is a new function, not a change to that one).
 * Explicit product requirement: a withdrawal must never be marked SUCCESS
 * just because the on-screen response wasn't recognized as a failure. Only
 * a response that positively matches a confirmed transfer-confirmation
 * pattern is SUCCESS; a recognized failure phrase (the same
 * FAILURE_RESPONSE_KEYWORDS above, including the two real captured
 * Reseller Withdraw failures this session — Somali insufficient-balance and
 * English "Receiver Account Not Found") is FAILED outright, not merely
 * ambiguous; anything else — including a genuine success confirmation this
 * list simply hasn't seen the exact wording of yet — is AMBIGUOUS, surfaced
 * for admin review rather than silently trusted either way.
 *
 * SUCCESS_RESPONSE_KEYWORDS is not invented wording — it reuses the exact
 * verbs already confirmed live for this same Hormuud/Somtel money-transfer-
 * out operation, just captured via the follow-up SMS rather than the
 * immediate on-screen response (see HormuudEvcPlusPayoutSentParser/
 * SomtelEdahabPayoutSentParser in PaymentSmsParsers.kt: "...uwareejisay...
 * "/"...warejisay..."/"...transferred..."). Both channels describe the
 * identical transaction and this telecom's own templated wording is
 * consistent across channels (e.g. HormuudEvcPlusParser's incoming vs.
 * HormuudEvcPlusPayoutSentParser's outgoing both keep the "[-EVCPLUS-]" tag
 * and near-identical structure) — reasonable evidence, not a guess, but
 * still provisional until a real on-screen SUCCESS sample is captured (see
 * Diagnostics -> reseller_withdrawal_self_heal_sweep entries) to lock this
 * down further.
 */
private val SUCCESS_RESPONSE_KEYWORDS = listOf("uwareejisay", "warejisay", "transferred")

fun classifyResellerWithdrawalUssdResponse(text: String): DialOutcome {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return DialOutcome.AMBIGUOUS
    val lower = trimmed.lowercase()
    if (FAILURE_RESPONSE_KEYWORDS.any { lower.contains(it) }) return DialOutcome.FAILED
    if (SUCCESS_RESPONSE_KEYWORDS.any { lower.contains(it) }) return DialOutcome.SUCCESS
    return DialOutcome.AMBIGUOUS
}
