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
        // Defaults to classifyRechargeUssdResponse (see below) — Internet
        // Store's UssdOrchestrator relies on this default; Reseller Withdraw
        // passes its own classifyResellerWithdrawalUssdResponse instead of
        // forking this whole function. Both are now the same fail-closed
        // shape: SUCCESS requires a positive match against real confirmed
        // wording, never a default. A production audit (2026-08-31) found
        // this default previously fell back to SUCCESS for ANY response that
        // didn't match a failure keyword — real carrier errors ("PIN Code
        // length is not valid", "Unrecognized mobile number.", "ShortCode is
        // not allowed for this number", the Somali insufficient-balance
        // phrasing, and Somtel's own negated "kumaad guulaysan" = "you did
        // NOT succeed") were captured in production with status='success'.
        // See classifyRechargeUssdResponse's own doc comment for the real
        // captured SUCCESS text this was fixed against.
        classify: (String) -> DialOutcome = ::classifyRechargeUssdResponse,
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
 * NOT exhaustive — expand this list as real ambiguous/failure responses are
 * observed in production (see the Payment History dial-attempt log, which
 * records every AMBIGUOUS response's raw text for exactly this purpose).
 * Blank/empty text is also treated as a failure signal — a real confirmation
 * always has some content. Shared by both classifiers below; used as the
 * FAILED branch, never as the sole basis for SUCCESS (see
 * classifyRechargeUssdResponse/classifyResellerWithdrawalUssdResponse — a
 * response matching none of these AND none of a classifier's own positive
 * SUCCESS list is AMBIGUOUS, never SUCCESS by default).
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
    // The following were all captured live from real production
    // ussd_dial_attempts rows recorded with status='success' during the
    // 2026-08-31 audit — every one of these is a genuine carrier failure
    // that the old default-to-SUCCESS classify() lambda in dial() had
    // waved through, meaning real customers were told a top-up succeeded
    // when the carrier had just refused it:
    //   - "Unrecognized mobile number." (Somnet)
    //   - "PIN Code length is not valid" (Hormuud)
    //   - "ShortCode is not allowed for this number" (Hormuud)
    //   - Somtel's own negated confirmation template, "Yaasiin, kumaad
    //     guulaysan inaad wareejiso Dhammays, fadlan mar kale isku day."
    //     ("you did NOT succeed in transferring Dhammays, please try
    //     again") — note this is NOT a substring of the real success
    //     template's "guulaysatay" (see SUCCESS_RESPONSE_KEYWORDS_RECHARGE
    //     below); the two verb forms never collide.
    "unrecognized", "not valid", "not allowed", "kumaad guulaysan",
)

fun looksLikeFailureResponse(text: String): Boolean {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return true
    val lower = trimmed.lowercase()
    return FAILURE_RESPONSE_KEYWORDS.any { lower.contains(it) }
}

/**
 * Internet Store recharge's on-screen response classifier — three-way
 * (SUCCESS/FAILED/AMBIGUOUS), fail-closed: SUCCESS requires a positive match
 * against real confirmed top-up-confirmation wording, never a default. This
 * replaces a prior default-to-SUCCESS-unless-recognized-as-failure design
 * that a 2026-08-31 production audit found had already caused real false
 * SUCCESS classifications (see FAILURE_RESPONSE_KEYWORDS's doc comment for
 * the exact captured examples). Mirrors classifyResellerWithdrawalUssdResponse
 * below, which was hardened the same way earlier for the same reason on a
 * different operation.
 *
 * SUCCESS_RESPONSE_KEYWORDS_RECHARGE is real captured production text, not
 * invented wording — pulled directly from ussd_dial_attempts rows recorded
 * live during the same audit:
 *   - Hormuud EVC Plus / Somnet JEEB: "<-E-Voucher-/-Jeeb-> Waxaad $X ugu
 *     shubtay <number>, Haraagaagu waa $Y." ("you topped up $X to <number>,
 *     your balance is $Y") — "ugu shubtay" ("topped up to"), a DIFFERENT verb
 *     from Reseller Withdrawal's "wareejisay" ("transferred") even though
 *     both operations dial through the same *712*-family EVC Plus code —
 *     confirms recharge and payout confirmations use distinct wording and
 *     must not share a keyword list.
 *   - Somtel eDahab: "Yaasiin, waxaad ku guulaysatay inaad lambarkan <number>
 *     u wareejiso $X oo <package> ah. Haraagaagu waa: $Y. Mahadsanid!" ("you
 *     succeeded in transferring $X <package> to this number") —
 *     "guulaysatay" ("succeeded").
 *
 * Amtel is out of scope for this classifier entirely: companies.gateway is
 * 'Manual' for Amtel (payment_ussd_template is NULL), so no USSD is ever
 * dialed for it — see admin-backend-ts/src/db/seed.ts.
 */
private val SUCCESS_RESPONSE_KEYWORDS_RECHARGE = listOf("guulaysatay", "ugu shubtay")

fun classifyRechargeUssdResponse(text: String): DialOutcome {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return DialOutcome.AMBIGUOUS
    val lower = trimmed.lowercase()
    if (FAILURE_RESPONSE_KEYWORDS.any { lower.contains(it) }) return DialOutcome.FAILED
    if (SUCCESS_RESPONSE_KEYWORDS_RECHARGE.any { lower.contains(it) }) return DialOutcome.SUCCESS
    return DialOutcome.AMBIGUOUS
}

/**
 * Reseller Withdraw's OWN response classifier — three-way (SUCCESS/FAILED/
 * AMBIGUOUS), same fail-closed shape as classifyRechargeUssdResponse above
 * (each operation gets its own positive-match SUCCESS list since the two
 * operations' real confirmation wording differs — see that function's doc
 * comment). Explicit product requirement: a withdrawal must never be marked
 * SUCCESS just because the on-screen response wasn't recognized as a
 * failure. Only a response that positively matches a confirmed transfer-
 * confirmation pattern is SUCCESS; a recognized failure phrase (the same
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
 * SomtelEdahabPayoutSentParser/SomtelWareejisayPayoutSentParser in
 * PaymentSmsParsers.kt: "...uwareejisay..."/"...warejisay..."/"...ku
 * wareejisay..."/"...transferred..."). Both channels describe the identical
 * transaction and this telecom's own templated wording is consistent across
 * channels (e.g. HormuudEvcPlusParser's incoming vs.
 * HormuudEvcPlusPayoutSentParser's outgoing both keep the "[-EVCPLUS-]" tag
 * and near-identical structure) — reasonable evidence, not a guess, but
 * still provisional until a real on-screen SUCCESS sample is captured (see
 * Diagnostics -> reseller_withdrawal_self_heal_sweep entries) to lock this
 * down further.
 *
 * "wareejisay" (double-e — SomtelWareejisayPayoutSentParser's real captured
 * "Waxaad ku wareejisay $X Dollars macmiilka...") was missing here even
 * though its SMS-side parser was added specifically because that exact
 * wording is real and confirmed — this on-screen classifier was never
 * updated to match, so a Somtel interactive payout whose on-screen
 * confirmation used this spelling stayed AMBIGUOUS (stuck at 'sent') on
 * the very first dial attempt instead of completing immediately, the same
 * way Hormuud's "uwareejisay" already does. "uwareejisay" itself already
 * contains "wareejisay" as a substring, so this one addition also covers
 * Hormuud without changing its existing behavior.
 */
private val SUCCESS_RESPONSE_KEYWORDS = listOf("wareejisay", "warejisay", "transferred")

fun classifyResellerWithdrawalUssdResponse(text: String): DialOutcome {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return DialOutcome.AMBIGUOUS
    val lower = trimmed.lowercase()
    if (FAILURE_RESPONSE_KEYWORDS.any { lower.contains(it) }) return DialOutcome.FAILED
    if (SUCCESS_RESPONSE_KEYWORDS.any { lower.contains(it) }) return DialOutcome.SUCCESS
    return DialOutcome.AMBIGUOUS
}
