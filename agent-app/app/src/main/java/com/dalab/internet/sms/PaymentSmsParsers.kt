package com.dalab.internet.sms

import com.dalab.internet.data.SmsLogEntry

/**
 * One parser per telecom payment SMS format. Add a new object once a
 * provider's exact SMS format is confirmed with a real sample, and register
 * it in [PaymentSmsParsers.ALL] — nothing else needs to change.
 *
 * Amtel's format is still unconfirmed — no real sample has been provided, so
 * no parser exists for it yet. Its payment SMS are currently ignored rather
 * than guessed at (a wrong regex here risks mis-parsing a real payment).
 */
interface PaymentSmsParser {
    val senders: List<String>
    fun tryParse(sender: String, body: String, receivedAt: String): SmsLogEntry?
}

/**
 * Hormuud EVC Plus confirmation SMS.
 * Example: "[-EVCPLUS-] waxaad $1 ka heshay 0610346060, Tar: 24/07/26"
 * Sender:  "192" or "EVCPLUS"
 */
object HormuudEvcPlusParser : PaymentSmsParser {
    override val senders = listOf("192", "EVCPLUS")

    private val pattern = Regex(
        """waxaad\s+\$?\s*([\d.]+)\s*\$?\s*ka\s+heshay\s+(\d{6,12}),?\s*Tar:\s*([\d/]+)""",
        RegexOption.IGNORE_CASE
    )

    override fun tryParse(sender: String, body: String, receivedAt: String): SmsLogEntry? {
        if (senders.none { it.equals(sender.trim(), ignoreCase = true) }) return null
        val match = pattern.find(body) ?: return null
        val (amount, phone, _) = match.destructured
        return SmsLogEntry(
            sender = sender,
            body = body,
            parsedProvider = "Hormuud",
            parsedAmount = amount.toDoubleOrNull(),
            parsedPhone = phone,
            receivedAt = receivedAt,
        )
    }
}

/**
 * Somtel eDahab confirmation SMS. Unlike Hormuud's, the payer's phone number
 * isn't the first thing after the amount — the payer's *name* is, with the
 * phone number in a separate "Lambarka" (number) field further along, so the
 * pattern skips across the name rather than assuming a fixed position.
 * Example: "0.22 Dollar Ayaad Ka Heshay Yaasiin Maxamed Aadan.Code-ka:NA.
 *           Lambarka :620346060  Aqanoosiga : PP260718.0005.F75709
 *           Haraagaaga Cusubi Waa: 2.61 Dollar..Tariikh:18-07-2026[-eDahab-Service-]"
 * No confirmed SMS sender/shortcode was provided for this format — matched
 * by the body's distinctive "eDahab" tag instead of an allowed-senders list.
 * If a real sender ID/shortcode is ever confirmed, tighten this the same way
 * HormuudEvcPlusParser restricts on `senders`.
 */
object SomtelEdahabParser : PaymentSmsParser {
    override val senders: List<String> = emptyList()

    private val pattern = Regex(
        """([\d.]+)\s*Dollar\s+Ayaad\s+Ka\s+Heshay[\s\S]*?Lambarka\s*:\s*(\d{6,15})""",
        RegexOption.IGNORE_CASE
    )

    override fun tryParse(sender: String, body: String, receivedAt: String): SmsLogEntry? {
        if (!body.contains("eDahab", ignoreCase = true)) return null
        val match = pattern.find(body) ?: return null
        val (amount, phone) = match.destructured
        return SmsLogEntry(
            sender = sender,
            body = body,
            parsedProvider = "Somtel",
            parsedAmount = amount.toDoubleOrNull(),
            parsedPhone = phone,
            receivedAt = receivedAt,
        )
    }
}

/**
 * Somnet's confirmation SMS is also EVCPlus-branded but a different format
 * from Hormuud's (no "waxaad"/"Tar:"), disambiguated by the required
 * "via Somnet Telecom" phrase — the payer's phone is in parentheses after
 * their name, and the amount right after "ayaad ka Heshay" is the
 * transaction amount, not the "Haraagaagu waa $X" balance figure later in
 * the message, which the pattern deliberately doesn't capture.
 * Example: "[-EVCPlus-] $0.1 ayaad ka Heshay AARAN DATA SERVICE
 *           (252685115555),27/07/26 04:49:01 via Somnet Telecom,
 *           Haraagaagu waa $4.95."
 * No confirmed SMS sender/shortcode was provided for this format either —
 * matched by the body's "Somnet" tag instead of an allowed-senders list.
 */
object SomnetEvcPlusParser : PaymentSmsParser {
    override val senders: List<String> = emptyList()

    private val pattern = Regex(
        """\$([\d.]+)\s*ayaad\s+ka\s+Heshay\s+.+?\((\d{6,15})\)[\s\S]*?via\s+Somnet\s+Telecom""",
        RegexOption.IGNORE_CASE
    )

    override fun tryParse(sender: String, body: String, receivedAt: String): SmsLogEntry? {
        if (!body.contains("Somnet", ignoreCase = true)) return null
        val match = pattern.find(body) ?: return null
        val (amount, phone) = match.destructured
        return SmsLogEntry(
            sender = sender,
            body = body,
            parsedProvider = "Somnet",
            parsedAmount = amount.toDoubleOrNull(),
            parsedPhone = phone,
            receivedAt = receivedAt,
        )
    }
}

/**
 * Registry the receiver consults. Unrecognized senders/formats are ignored — not
 * every SMS on the agent's phone is a payment notification, and we never want to
 * accidentally ingest an unrelated personal message.
 *
 * TODO: add an Amtel parser once its SMS format is confirmed with a real
 * sample, following the same shape as the parsers above.
 */
object PaymentSmsParsers {
    val ALL: List<PaymentSmsParser> = listOf(
        HormuudEvcPlusParser,
        SomtelEdahabParser,
        SomnetEvcPlusParser,
    )

    fun parse(sender: String, body: String, receivedAt: String): SmsLogEntry? {
        for (parser in ALL) {
            parser.tryParse(sender, body, receivedAt)?.let { return it }
        }
        return null
    }
}
