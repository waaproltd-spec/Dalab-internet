package com.dalab.internet.sms

import com.dalab.internet.data.SmsLogEntry

/**
 * One parser per telecom payment SMS format. Add a new object once a
 * provider's exact SMS format is confirmed with a real sample, and register
 * it in [PaymentSmsParsers.ALL] — nothing else needs to change.
 *
 * Amtel deliberately has no parser here: Amtel doesn't send payment
 * confirmation SMS at all (it's used for data transfer/service delivery
 * only), so there's nothing to parse — Amtel orders are verified through
 * the data-delivery/service API flow instead of SMS matching.
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
 * accidentally ingest an unrelated personal message. No Amtel entry here by
 * design — see the interface doc comment above.
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

/**
 * The OUTGOING half of the pipeline: confirmation that the agent's OWN SIM
 * successfully sent a top-up/voucher to a customer (as opposed to
 * [PaymentSmsParser], which detects the customer's incoming payment). Used
 * as a corroborating signal alongside the USSD dial's own on-screen response
 * text — see UssdOrchestrator — since some OEM/carrier USSD response
 * callbacks are unreliable or generic, and this SMS is a second, independent
 * confirmation from the carrier itself.
 */
data class VoucherSentEntry(val receiverPhone: String, val amount: Double, val provider: String)

interface VoucherSentParser {
    val senders: List<String>
    fun tryParse(sender: String, body: String): VoucherSentEntry?
}

/**
 * Hormuud's E-Voucher (top-up sent) confirmation SMS.
 * Example: "[-E-Voucher-] You have transferred $0.1 to 252619991299. Your balance is $0.27."
 * Sender: "740"
 */
object HormuudEVoucherParser : VoucherSentParser {
    override val senders = listOf("740")

    private val pattern = Regex(
        """transferred\s+\$?\s*([\d.]+)\s+to\s+(\d{6,15})""",
        RegexOption.IGNORE_CASE
    )

    override fun tryParse(sender: String, body: String): VoucherSentEntry? {
        if (senders.none { it.equals(sender.trim(), ignoreCase = true) }) return null
        val match = pattern.find(body) ?: return null
        val (amount, phone) = match.destructured
        val parsedAmount = amount.toDoubleOrNull() ?: return null
        return VoucherSentEntry(receiverPhone = phone, amount = parsedAmount, provider = "Hormuud")
    }
}

/** Registry for outgoing voucher-sent confirmations — mirrors [PaymentSmsParsers]. */
object VoucherSentParsers {
    val ALL: List<VoucherSentParser> = listOf(HormuudEVoucherParser)

    fun parse(sender: String, body: String): VoucherSentEntry? {
        for (parser in ALL) {
            parser.tryParse(sender, body)?.let { return it }
        }
        return null
    }
}
