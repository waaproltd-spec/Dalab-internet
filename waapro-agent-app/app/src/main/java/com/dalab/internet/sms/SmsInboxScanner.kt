package com.dalab.internet.sms

import android.content.Context
import android.provider.Telephony
import com.dalab.internet.data.SmsLogEntry
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.queue.PendingActionQueue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/**
 * Missed-SMS recovery: runs the same parse -> upload -> match -> verify ->
 * dial pipeline as [SmsReceiver], against the SMS inbox (READ_SMS), for any
 * payment SMS the live receiver never handled -- it arrived while the
 * receiver couldn't act, the process died mid-upload, or the phone was off.
 *
 * Runs whenever there's a chance something was missed (app start, the
 * background service starting, the app coming to the foreground, SMS
 * permission being granted, connectivity returning, and every few minutes
 * from the background service) -- not once per process as before, which
 * left an SMS missed after the first pass waiting until the process happened
 * to die. One pass at a time; passes closer than
 * [SmsRecoveryLogic.MIN_INTERVAL_MS] are skipped unless forced.
 *
 * Each pass reads from [SmsRecoveryLogic.OVERLAP_MS] before the last
 * completed pass (bounded to the last 24h, at most [MAX_MESSAGES]), and
 * skips every SMS already acknowledged by the server or still in the upload
 * queue (by fingerprint), so overlap never means a second upload. The
 * checkpoint is persisted, so this continues correctly after process death
 * or a reboot.
 */
object SmsInboxScanner {
    private const val PREFS = "dalab_agent_sms_scan"
    private const val KEY_LAST_SCANNED_AT = "last_scanned_at"
    private const val MAX_MESSAGES = 200

    private val mutex = Mutex()
    @Volatile private var lastPassStartedAt = 0L

    /** Kept for existing callers (app start / permission granted). */
    suspend fun scanRecentInboxOnce(context: Context) = recover(context, "app_start", force = true)

    /** One recovery pass for [reason]. Never throws. */
    suspend fun recover(context: Context, reason: String, force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastPassStartedAt < SmsRecoveryLogic.MIN_INTERVAL_MS) return
        if (!mutex.tryLock()) return // a pass is already running; it covers this one
        try {
            lastPassStartedAt = now
            val appContext = context.applicationContext
            if (!SmsListenerState.refresh(appContext)) return // logged as sms_permission_missing
            recoverLocked(appContext, reason)
        } catch (e: Exception) {
            DiagnosticsLog.record("sms_recovery_failed", "Recovery pass ($reason) failed: ${e.stackTraceToString().take(2000)}")
        } finally {
            mutex.unlock()
        }
    }

    private suspend fun recoverLocked(context: Context, reason: String) = withContext(Dispatchers.IO) {
        SmsFingerprintStore.init(context)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val passStartedAt = System.currentTimeMillis()
        val cutoff = SmsRecoveryLogic.recoveryCutoff(prefs.getLong(KEY_LAST_SCANNED_AT, 0L), passStartedAt)

        val inbox = readInbox(context, cutoff) ?: return@withContext
        val queuedIds = PendingActionQueue.all().map { it.id }.toSet()
        // Handled = acknowledged by the server, or still durably queued (the
        // drainer sends it). A "queued" mark whose queue entry is gone is
        // taken in again rather than trusted.
        val todo = SmsRecoveryLogic.messagesToRecover(inbox) { fp ->
            SmsFingerprintStore.isAcked(fp) || SmsUploadFlow.queueIdFor(fp) in queuedIds
        }
        DiagnosticsLog.record(
            "sms_recovery_started",
            "Inbox recovery ($reason): ${inbox.size} SMS since ${Date(cutoff)}, ${todo.size} not yet handled.",
            isError = false,
        )

        var taken = 0
        for (message in todo) {
            try {
                if (processOne(context, message, reason)) taken++
            } catch (e: Exception) {
                DiagnosticsLog.record("sms_inbox_scan_item", "Failed on one inbox message: ${e.stackTraceToString().take(1000)}")
            }
        }

        // Saved only once the pass has gone through every message; an
        // interrupted pass is simply redone from the old checkpoint, and
        // fingerprints stop anything from being sent twice.
        prefs.edit().putLong(KEY_LAST_SCANNED_AT, passStartedAt).apply()
        DiagnosticsLog.record(
            "sms_recovery_completed",
            "Inbox recovery ($reason) done: $taken payment SMS recovered.",
            isError = false,
        )
    }

    private fun readInbox(context: Context, cutoff: Long): List<SmsRecoveryLogic.InboxMessage>? {
        val base = arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE)
        fun query(projection: Array<String>) = context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            projection,
            "${Telephony.Sms.DATE} > ?",
            arrayOf(cutoff.toString()),
            "${Telephony.Sms.DATE} DESC LIMIT $MAX_MESSAGES",
        )
        // The SIM column is standard since Android 5.1, but an OEM SMS
        // provider that rejects it must not stop recovery altogether.
        val cursor = (try {
            query(base + Telephony.Sms.SUBSCRIPTION_ID)
        } catch (_: Exception) {
            query(base)
        }) ?: return null
        val messages = mutableListOf<SmsRecoveryLogic.InboxMessage>()
        cursor.use {
            val addressIdx = it.getColumnIndex(Telephony.Sms.ADDRESS)
            val bodyIdx = it.getColumnIndex(Telephony.Sms.BODY)
            val dateIdx = it.getColumnIndex(Telephony.Sms.DATE)
            val subIdx = it.getColumnIndex(Telephony.Sms.SUBSCRIPTION_ID)
            while (it.moveToNext()) {
                val address = if (addressIdx >= 0) it.getString(addressIdx) else null
                val body = if (bodyIdx >= 0) it.getString(bodyIdx) else null
                val date = if (dateIdx >= 0) it.getLong(dateIdx) else 0L
                val subId = if (subIdx >= 0 && !it.isNull(subIdx)) it.getInt(subIdx) else null
                if (address != null && body != null) messages.add(SmsRecoveryLogic.InboxMessage(address, body, date, subId))
            }
        }
        return messages
    }

    /** Same branches as [SmsReceiver]. Returns whether it was a payment SMS. */
    private suspend fun processOne(context: Context, message: SmsRecoveryLogic.InboxMessage, reason: String): Boolean {
        val sender = message.sender
        val body = message.body
        val receivedAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).format(Date(message.dateMs))
        // The SIM it arrived on, like the live receiver sends: a device that
        // collects on both SIMs refuses a payment SMS with no slot.
        val simSlot = message.subscriptionId?.let { simSlotForSubscription(context, it) }
        val source = "recovery:$reason"

        val parsed = PaymentSmsParsers.parse(sender, body, receivedAt, simSlot)
        val voucherSent = if (parsed == null) VoucherSentParsers.parse(sender, body) else null
        val exchangePayoutSent = if (parsed == null && voucherSent == null) ExchangePayoutSentParsers.parse(sender, body) else null

        if (parsed == null && voucherSent == null && exchangePayoutSent == null) {
            if (!looksLikePaymentSms(body)) return false
            SmsUploadFlow.intake(context, SmsLogEntry(sender = sender, body = body, receivedAt = receivedAt, simSlot = simSlot), source)
            return true
        }

        if (voucherSent != null) {
            if (SmsUploadFlow.reportVoucherConfirmation(voucherSent) is UploadOutcome.RetryableUpload) {
                PendingActionQueue.enqueue(
                    id = UUID.randomUUID().toString(),
                    type = PendingActionQueue.Type.VOUCHER_CONFIRMATION,
                    payload = VoucherConfirmationAction(voucherSent),
                )
            }
            // Same balance-carrying upload the live receiver sends (no
            // amount/phone, so it can never match an order).
            SmsUploadFlow.intake(context, SmsLogEntry(sender = sender, body = body, receivedAt = receivedAt, simSlot = simSlot), source)
            return true
        }
        if (exchangePayoutSent != null) {
            if (SmsUploadFlow.reportExchangePayoutConfirmation(exchangePayoutSent) is UploadOutcome.RetryableUpload) {
                PendingActionQueue.enqueue(
                    id = UUID.randomUUID().toString(),
                    type = PendingActionQueue.Type.EXCHANGE_PAYOUT_CONFIRMATION,
                    payload = ExchangePayoutConfirmationAction(exchangePayoutSent),
                )
            }
            SmsUploadFlow.intake(
                context,
                SmsLogEntry(
                    sender = sender,
                    body = body,
                    parsedProvider = exchangePayoutSent.provider,
                    parsedAmount = exchangePayoutSent.amount,
                    parsedPhone = exchangePayoutSent.receiverPhone,
                    receivedAt = receivedAt,
                    simSlot = simSlot,
                ),
                source,
            )
            return true
        }

        val entry = parsed!!
        SmsListenerState.recordLog(entry)
        SmsUploadFlow.intake(context, entry, source)
        return true
    }
}
