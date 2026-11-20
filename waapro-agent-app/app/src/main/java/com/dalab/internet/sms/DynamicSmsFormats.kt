package com.dalab.internet.sms

import android.content.Context
import android.content.SharedPreferences
import com.dalab.internet.data.SmsLogEntry
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.SmsFormatDto
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

/**
 * SMS Format Update: payment-SMS formats the Super Admin activates from the
 * dashboard (GET /agent/sms-formats, smsFormats.routes.ts) when a provider
 * changes its SMS wording -- read here without an app update.
 *
 * Tried before the built-in parsers in [PaymentSmsParsers.parse], but each
 * format only ever reads SMS from its own provider's senders and only when
 * every one of its keywords is present, so one provider's format can't read
 * another provider's SMS. Kept on disk so a freshly started process (an SMS
 * broadcast waking the app, a reboot) has them before any network call --
 * [tryParse] runs on SmsReceiver's synchronous path and never fetches.
 *
 * Reading an SMS only fills in amount / payer number / reference; the
 * backend's matching + verification still decides whether it pays an order.
 */
object DynamicSmsFormats {
    private const val PREFS = "dalab_sms_formats"
    private const val KEY_FORMATS = "formats"
    private const val MAX_SMS_LENGTH = 2000

    private class Compiled(val dto: SmsFormatDto, val regex: Regex)

    @Volatile private var compiled: List<Compiled> = emptyList()
    private var prefs: SharedPreferences? = null
    private val gson = Gson()
    @Volatile private var lastLoggedFailure: String? = null

    fun init(context: Context) {
        if (prefs != null) return
        val p = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs = p
        val json = p.getString(KEY_FORMATS, null) ?: return
        try {
            val type = object : TypeToken<List<SmsFormatDto>>() {}.type
            replace(gson.fromJson<List<SmsFormatDto>>(json, type) ?: emptyList())
        } catch (e: Exception) {
            DiagnosticsLog.record("sms_formats_load", "Stored SMS formats unreadable: ${e.message}")
        }
    }

    suspend fun refresh(): Result<Unit> {
        return try {
            val response = ApiClient.service.getSmsFormats()
            val body = response.body()
            if (response.isSuccessful && body != null) {
                replace(body)
                prefs?.edit()?.putString(KEY_FORMATS, gson.toJson(body))?.apply()
                lastLoggedFailure = null
                Result.success(Unit)
            } else {
                logFailureIfNew("Failed to load SMS formats: HTTP ${response.code()}")
                Result.failure(IllegalStateException("HTTP ${response.code()}"))
            }
        } catch (e: Exception) {
            logFailureIfNew(e.message ?: "unknown error")
            Result.failure(e)
        }
    }

    private fun logFailureIfNew(message: String) {
        if (message == lastLoggedFailure) return
        lastLoggedFailure = message
        DiagnosticsLog.record("sms_formats_refresh", message)
    }

    /** Swaps in a new set of formats, skipping (and logging) any that don't compile. */
    @Suppress("SENSELESS_COMPARISON")
    fun replace(formats: List<SmsFormatDto>) {
        compiled = formats.mapNotNull { dto ->
            // Gson can leave a missing list/string null despite the Kotlin type.
            if (dto.pattern == null || dto.keywords == null || dto.senders == null || dto.keywords.isEmpty()) return@mapNotNull null
            try {
                Compiled(dto, Regex(dto.pattern, RegexOption.IGNORE_CASE))
            } catch (e: Exception) {
                DiagnosticsLog.record("sms_formats_compile", "Skipping ${dto.provider} v${dto.version}: ${e.message}")
                null
            }
        }
    }

    fun tryParse(sender: String, body: String, receivedAt: String): SmsLogEntry? {
        val from = sender.trim()
        for (c in compiled) {
            if (c.dto.senders.none { it.trim().equals(from, ignoreCase = true) }) continue
            val read = read(c.dto, c.regex, body) ?: continue
            return SmsLogEntry(
                sender = sender,
                body = body,
                parsedProvider = c.dto.parsedProvider,
                parsedAmount = read.amount,
                parsedPhone = read.senderPhone,
                receivedAt = receivedAt,
                transactionRef = read.reference,
            )
        }
        return null
    }

    data class Read(val amount: Double, val senderPhone: String, val reference: String?)

    /** Same rules as applyRule() in the backend's utils/smsFormats.ts. */
    fun read(format: SmsFormatDto, regex: Regex, rawBody: String): Read? {
        val body = normalize(rawBody)
        val haystack = collapse(body)
        if (format.keywords.any { !haystack.contains(collapse(it)) }) return null
        val match = regex.find(body) ?: return null
        fun group(index: Int?): String? =
            index?.takeIf { it in 1 until match.groups.size }?.let { match.groups[it]?.value }?.takeIf { it.isNotEmpty() }
        val amount = group(format.amountGroup)?.replace(",", "")?.toDoubleOrNull()?.takeIf { it > 0 && it.isFinite() } ?: return null
        val phone = group(format.senderGroup)?.takeIf { PHONE.matches(it) } ?: return null
        return Read(amount, phone, group(format.referenceGroup))
    }

    private val PHONE = Regex("""\d{6,15}""")
    private val WHITESPACE = Regex("""\s+""")

    private fun normalize(body: String): String = body.replace('\u00A0', ' ').take(MAX_SMS_LENGTH)
    private fun collapse(text: String): String = text.replace(WHITESPACE, " ").trim().lowercase()
}
