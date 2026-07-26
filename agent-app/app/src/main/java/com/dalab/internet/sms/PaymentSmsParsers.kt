package com.dalab.internet.sms

import com.dalab.internet.data.SmsLogEntry

/**
 * One parser per telecom payment SMS format. Add a new object for Somtel/eDahab and
 * Somnet/JEEB once their exact SMS formats are confirmed, and register it in
 * [PaymentSmsParsers.ALL] — nothing else needs to change.
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
 * Registry the receiver consults. Unrecognized senders/formats are ignored — not
 * every SMS on the agent's phone is a payment notification, and we never want to
 * accidentally ingest an unrelated personal message.
 *
 * TODO: add SomtelEdahabParser and SomnetJeebParser here once their SMS formats
 * are confirmed, following the same shape as HormuudEvcPlusParser above.
 */
object PaymentSmsParsers {
    val ALL: List<PaymentSmsParser> = listOf(
        HormuudEvcPlusParser,
    )

    fun parse(sender: String, body: String, receivedAt: String): SmsLogEntry? {
        for (parser in ALL) {
            parser.tryParse(sender, body, receivedAt)?.let { return it }
        }
        return null
    }
}
