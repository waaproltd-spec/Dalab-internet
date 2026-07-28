package com.dalab.internet.sms

import android.content.Context
import android.provider.Telephony
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.queue.PendingActionQueue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/**
 * Runs the exact same parse -> upload -> match -> verify -> dial pipeline as
 * [SmsReceiver], but against the SMS inbox's existing content (via READ_SMS)
 * instead of a live broadcast (RECEIVE_SMS). Without this, READ_SMS was
 * requested at permission time but never actually used for anything —
 * granting it didn't make the app "read your SMS messages" the way the
 * permission screen's own copy implies, it only enabled the live receiver
 * (RECEIVE_SMS's job, not READ_SMS's).
 *
 * Bounded to a recent lookback window and a hard message cap rather than the
 * entire phone history: this exists to catch a genuine payment SMS that
 * arrived in the gap before the agent granted permission (or before this app
 * update shipped), not to dredge up years-old messages and generate
 * meaningless match attempts against orders that no longer exist.
 */
object SmsInboxScanner {
    private const val LOOKBACK_MS = 24 * 60 * 60 * 1000L
    private const val MAX_MESSAGES = 200

    // One pass per process lifetime is enough — this is a catch-up scan for
    // the permission-grant moment, not a substitute for the live receiver
    // that handles everything from here on.
    @Volatile private var hasScannedThisProcess = false

    suspend fun scanRecentInboxOnce(context: Context) {
        if (hasScannedThisProcess) return
        hasScannedThisProcess = true
        try {
            scanRecentInbox(context.applicationContext)
        } catch (e: Exception) {
            DiagnosticsLog.record("sms_inbox_scan", "Failed to scan SMS inbox: ${e.stackTraceToString().take(2000)}")
        }
    }

    private suspend fun scanRecentInbox(context: Context) = withContext(Dispatchers.IO) {
        val cutoff = System.currentTimeMillis() - LOOKBACK_MS
        val projection = arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE)
        val cursor = context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            projection,
            "${Telephony.Sms.DATE} >= ?",
            arrayOf(cutoff.toString()),
            "${Telephony.Sms.DATE} DESC LIMIT $MAX_MESSAGES",
        ) ?: return@withContext

        val messages = mutableListOf<Triple<String, String, Long>>()
        cursor.use {
            val addressIdx = it.getColumnIndex(Telephony.Sms.ADDRESS)
            val bodyIdx = it.getColumnIndex(Telephony.Sms.BODY)
            val dateIdx = it.getColumnIndex(Telephony.Sms.DATE)
            while (it.moveToNext()) {
                val address = if (addressIdx >= 0) it.getString(addressIdx) else null
                val body = if (bodyIdx >= 0) it.getString(bodyIdx) else null
                val date = if (dateIdx >= 0) it.getLong(dateIdx) else 0L
                if (address != null && body != null) messages.add(Triple(address, body, date))
            }
        }

        // Oldest first: if two messages would match the same order, process
        // them in the order they actually arrived.
        for ((sender, body, dateMs) in messages.asReversed()) {
            try {
                processOne(context, sender, body, dateMs)
            } catch (e: Exception) {
                DiagnosticsLog.record("sms_inbox_scan_item", "Failed on one inbox message: ${e.stackTraceToString().take(1000)}")
            }
        }
    }

    private suspend fun processOne(context: Context, sender: String, body: String, dateMs: Long) {
        val receivedAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).format(Date(dateMs))
        val parsed = PaymentSmsParsers.parse(sender, body, receivedAt)
        val voucherSent = if (parsed == null) VoucherSentParsers.parse(sender, body) else null
        if (parsed == null && voucherSent == null) return

        if (voucherSent != null) {
            if (SmsUploadFlow.reportVoucherConfirmation(voucherSent) is UploadOutcome.RetryableUpload) {
                PendingActionQueue.enqueue(
                    id = UUID.randomUUID().toString(),
                    type = PendingActionQueue.Type.VOUCHER_CONFIRMATION,
                    payload = VoucherConfirmationAction(voucherSent),
                )
            }
            return
        }

        val entry = parsed!!
        SmsListenerState.recordLog(entry)
        // Server-side sms_logs dedup (sender/body/minute) makes re-processing
        // a message the live receiver already saw a safe no-op, not a
        // duplicate order match — see admin-backend-ts smsLogs.routes.ts.
        when (val outcome = SmsUploadFlow.uploadAndProcess(context, entry)) {
            is UploadOutcome.RetryableUpload -> PendingActionQueue.enqueue(
                id = UUID.randomUUID().toString(),
                type = PendingActionQueue.Type.SMS_UPLOAD,
                payload = SmsUploadAction(entry),
            )
            is UploadOutcome.RetryableVerify -> PendingActionQueue.enqueue(
                id = UUID.randomUUID().toString(),
                type = PendingActionQueue.Type.VERIFY_PAYMENT,
                payload = VerifyPaymentAction(outcome.orderId, outcome.smsLogId, entry.parsedAmount),
            )
            is UploadOutcome.Terminal, UploadOutcome.Success -> {
                // Terminal: rejected outright, won't succeed on retry. Success: nothing further to do.
            }
        }
    }
}
