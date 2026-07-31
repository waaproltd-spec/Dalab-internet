package com.sahal.data.sms

import android.content.Context
import android.provider.Telephony
import com.sahal.data.diagnostics.DiagnosticsLog
import com.sahal.data.queue.PendingActionQueue
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
 *
 * The high-water mark below is persisted (not just an in-memory per-process
 * flag) precisely because a device stuck crash-looping would otherwise redo
 * the full 24h/200-message pass — dozens of sequential network calls — on
 * every single relaunch, which is real, avoidable load right when the app
 * is already struggling. After the first successful pass, a restart only
 * re-scans whatever actually arrived since the last pass, which is normally
 * zero or a handful of messages.
 */
object SmsInboxScanner {
    private const val PREFS = "sahal_data_agent_sms_scan"
    private const val KEY_LAST_SCANNED_AT = "last_scanned_at"
    private const val LOOKBACK_MS = 24 * 60 * 60 * 1000L
    private const val MAX_MESSAGES = 200

    @Volatile private var scanInFlightOrDoneThisProcess = false

    suspend fun scanRecentInboxOnce(context: Context) {
        if (scanInFlightOrDoneThisProcess) return
        scanInFlightOrDoneThisProcess = true
        try {
            scanRecentInbox(context.applicationContext)
        } catch (e: Exception) {
            DiagnosticsLog.record("sms_inbox_scan", "Failed to scan SMS inbox: ${e.stackTraceToString().take(2000)}")
        }
    }

    private suspend fun scanRecentInbox(context: Context) = withContext(Dispatchers.IO) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val scanStartedAt = System.currentTimeMillis()
        val lastScannedAt = prefs.getLong(KEY_LAST_SCANNED_AT, 0L)
        val cutoff = maxOf(lastScannedAt, scanStartedAt - LOOKBACK_MS)

        val projection = arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE)
        val cursor = context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            projection,
            "${Telephony.Sms.DATE} > ?",
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

        // Recorded before processing, not after: if this pass is interrupted
        // (crash, process death) partway through, a retry only has to redo
        // the remaining new messages, not the same already-attempted batch.
        prefs.edit().putLong(KEY_LAST_SCANNED_AT, scanStartedAt).apply()

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
