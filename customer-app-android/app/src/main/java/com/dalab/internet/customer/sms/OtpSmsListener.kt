package com.dalab.internet.customer.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/**
 * Pulls the 4+ digit verification code out of an incoming SMS body. Anchored to
 * the phrase "code is" (matches the gateway's expected wording, e.g. "...Your
 * code is\n\n8923\n\nEnter this code below") rather than grabbing the first
 * digit run in the message — otherwise a phone number elsewhere in the same
 * SMS (e.g. "Verification number: +252 610346060") could be picked up instead.
 */
object OtpCodeExtractor {
    // Exactly 4 digits — matches the backend's generateOtp() (randomInt(1000, 10000))
    // so a detected code is always the same shape the verify screen's 4-box
    // input and the /auth/otp/verify call already expect.
    private val pattern = Regex("""code\s+is[\s\S]{0,12}?(\d{4})\b""", RegexOption.IGNORE_CASE)

    fun extract(body: String): String? = pattern.find(body)?.groupValues?.getOrNull(1)
}

/**
 * Registered dynamically only while the OTP code-entry step is on screen (see
 * OtpLoginScreen) and unregistered the moment it isn't — this app has no
 * standing/background SMS listener, unlike the Agent App's payment-SMS
 * receiver, since auto-filling a code is only ever relevant during that one
 * screen. If RECEIVE_SMS is denied, this never gets registered and the
 * customer just types the code manually, exactly as before.
 */
class OtpSmsReceiver(private val onCodeDetected: (String) -> Unit) : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val body = Telephony.Sms.Intents.getMessagesFromIntent(intent)
            .joinToString(separator = "") { it.messageBody ?: "" }
        OtpCodeExtractor.extract(body)?.let(onCodeDetected)
    }
}
