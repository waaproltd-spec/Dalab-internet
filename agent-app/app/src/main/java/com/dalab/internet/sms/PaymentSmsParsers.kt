package com.dalab.internet.sms

import com.dalab.internet.data.SmsLogEntry

/**
 * One parser per telecom payment SMS format. Add a new object once a
 * provider's exact SMS format is confirmed with a real sample, and register
 * it in [PaymentSmsParsers.ALL] — nothing else needs to change.
 *
 * Amtel has no parser here YET. The original assumption (Amtel doesn't send
 * payment confirmation SMS — data transfer/service delivery only, verified
 * through a separate "data-delivery/service API flow") was never actually
 * implemented anywhere in this codebase, and Amtel now has a live
 * "Evc plus"-labeled company_payment_methods entry that dials a USSD payment
 * code exactly like Hormuud/Somnet/Somtel — meaning real Amtel payments have
 * no automatic verification path at all right now and get stuck 'pending'
 * forever. SmsReceiver.kt's unrecognized-payment-SMS branch uploads any
 * Amtel-looking SMS unparsed (see PAYMENT_LOOKING_KEYWORDS) so it's at least
 * visible in the backend's SMS Logs instead of silently vanishing; once a
 * real Amtel confirmation SMS sample is captured there, add a parser here
 * the same way HormuudEvcPlusParser etc. were added.
 */
interface PaymentSmsParser {
    val senders: List<String>
    fun tryParse(sender: String, body: String, receivedAt: String): SmsLogEntry?
}

/** Amount capture group shared by every parser below — accepts an optional
 * comma thousands-separator (e.g. "$1,234.56") alongside a plain decimal
 * (e.g. "$0.09"), since a real payment isn't guaranteed to be small just
 * because this system's own test packages have been. */
private const val AMOUNT_PATTERN = """([\d,]+(?:\.\d+)?)"""

/** Strips thousands-separator commas before parsing — "1,234.56" -> 1234.56. */
private fun parseAmount(raw: String): Double? = raw.replace(",", "").toDoubleOrNull()

/**
 * Hormuud EVC Plus confirmation SMS.
 * Example: "[-EVCPLUS-] waxaad $1 ka heshay 0610346060, Tar: 24/07/26"
 * Sender:  "192" or "EVCPLUS"
 */
object HormuudEvcPlusParser : PaymentSmsParser {
    override val senders = listOf("192", "EVCPLUS")

    private val pattern = Regex(
        """waxaad\s+\$?\s*$AMOUNT_PATTERN\s*\$?\s*ka\s+heshay\s+(\d{6,12}),?\s*Tar:\s*([\d/]+)""",
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
            parsedAmount = parseAmount(amount),
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
    // Confirmed live this session: a real eDahab-formatted SMS's actual
    // originatingAddress (read directly by SmsReceiver.kt, not a
    // UI-resolved contact name) was logged as exactly "eDahab" -- and the
    // same sender carries both this incoming-payment format and
    // SomtelEdahabPayoutSentParser's outgoing-payout format (same SMS
    // thread). Previously unvalidated ("No confirmed SMS sender/shortcode
    // was provided for this format") -- now locked down the same way
    // HormuudEvcPlusParser already validates its senders.
    override val senders: List<String> = listOf("eDahab")

    private val pattern = Regex(
        """$AMOUNT_PATTERN\s*Dollar\s+Ayaad\s+Ka\s+Heshay[\s\S]*?Lambarka\s*:\s*(\d{6,15})""",
        RegexOption.IGNORE_CASE
    )

    // "Aqanoosiga" (receipt/confirmation code) is this format's own unique
    // per-transaction reference — e.g. "PP260718.0005.F75709". Extracted
    // separately from `pattern` above (rather than folded into one regex) so
    // a missing/reformatted reference field never breaks basic amount+phone
    // parsing — it's a bonus dedup signal, not a requirement for a match.
    private val referencePattern = Regex("""Aqanoosiga\s*:\s*(\S+)""", RegexOption.IGNORE_CASE)

    override fun tryParse(sender: String, body: String, receivedAt: String): SmsLogEntry? {
        if (senders.none { it.equals(sender.trim(), ignoreCase = true) }) return null
        if (!body.contains("eDahab", ignoreCase = true)) return null
        val match = pattern.find(body) ?: return null
        val (amount, phone) = match.destructured
        val reference = referencePattern.find(body)?.groupValues?.get(1)
        return SmsLogEntry(
            sender = sender,
            body = body,
            parsedProvider = "Somtel",
            parsedAmount = parseAmount(amount),
            parsedPhone = phone,
            receivedAt = receivedAt,
            transactionRef = reference,
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
        """\$$AMOUNT_PATTERN\s*ayaad\s+ka\s+Heshay\s+.+?\((\d{6,15})\)[\s\S]*?via\s+Somnet\s+Telecom""",
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
            parsedAmount = parseAmount(amount),
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

    // simSlot is attached via copy() after a parser matches, rather than
    // threaded through every PaymentSmsParser.tryParse signature — it's
    // metadata about which SIM the broadcast arrived on, not something any
    // individual provider's text format has a say in.
    fun parse(sender: String, body: String, receivedAt: String, simSlot: Int? = null): SmsLogEntry? {
        for (parser in ALL) {
            parser.tryParse(sender, body, receivedAt)?.let { return it.copy(simSlot = simSlot) }
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
        """transferred\s+\$?\s*$AMOUNT_PATTERN\s+to\s+(\d{6,15})""",
        RegexOption.IGNORE_CASE
    )

    override fun tryParse(sender: String, body: String): VoucherSentEntry? {
        if (senders.none { it.equals(sender.trim(), ignoreCase = true) }) return null
        val match = pattern.find(body) ?: return null
        val (amount, phone) = match.destructured
        val parsedAmount = parseAmount(amount) ?: return null
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

/**
 * Money Exchange's own outgoing-confirmation half — same idea as
 * [VoucherSentParser] (Internet Store), but for a Money Exchange payout: the
 * carrier's own SMS confirming the payout wallet's SIM sent money to a
 * customer's recipient, received on the payout wallet's own phone. A
 * corroborating signal independent of ExchangeUssdOrchestrator's on-screen
 * step2 classification, since that on-screen reading can misclassify a
 * genuinely successful payout as failed — confirmed live: order
 * DEX176626979 completed for real (this exact SMS arrived) while the
 * automation reported STEP2_FAILED because a stray accessibility-service
 * event beat the real PIN injection to the result channel.
 */
data class ExchangePayoutConfirmedEntry(val receiverPhone: String, val amount: Double, val provider: String, val rawText: String)

interface ExchangePayoutSentParser {
    val senders: List<String>
    fun tryParse(sender: String, body: String): ExchangePayoutConfirmedEntry?
}

/**
 * Somtel eDahab's outgoing-transfer confirmation SMS.
 * Example: "1.98 Dollar ayad u warejisay Yaasiin Maxamed Aadan. No:
 *           620346060.Tixrac: PP260808.2240.E07703 Haraaga: 7.08 Dollar
 *           Kharashyada Adeegga:0"
 * Confirmed live this session: this SMS arrives in the same thread (same
 * originatingAddress) as SomtelEdahabParser's incoming-payment format,
 * whose real sender was independently confirmed as "eDahab" via
 * Diagnostics -- so this outgoing side shares that same sender. Previously
 * unvalidated ("No confirmed sender ID for this format") -- matched on the
 * distinctive "u warejisay" ("transferred to") phrase plus the recipient's
 * "No:" field, now also requiring the sender to match.
 */
object SomtelEdahabPayoutSentParser : ExchangePayoutSentParser {
    override val senders: List<String> = listOf("eDahab")

    private val pattern = Regex(
        """$AMOUNT_PATTERN\s*Dollar\s+ayad?\s+u\s+warejisay[\s\S]*?No:\s*(\d{6,15})""",
        RegexOption.IGNORE_CASE
    )

    override fun tryParse(sender: String, body: String): ExchangePayoutConfirmedEntry? {
        if (senders.none { it.equals(sender.trim(), ignoreCase = true) }) return null
        val match = pattern.find(body) ?: return null
        val (amount, phone) = match.destructured
        val parsedAmount = parseAmount(amount) ?: return null
        return ExchangePayoutConfirmedEntry(receiverPhone = phone, amount = parsedAmount, provider = "Somtel", rawText = body)
    }
}

/**
 * Hormuud EVC Plus's outgoing-transfer confirmation SMS.
 * Example: "[-EVCPLUS-] $1.98 ayaad uwareejisay YASIIN MAXAMED AADAN
 *           (610346060), Tar: 09/08/26 20:32:27, Haraagaagu waa $36.965."
 * Mirrors HormuudEvcPlusParser's incoming counterpart -- same "[-EVCPLUS-]"
 * tag, but "ayaad uwareejisay" ("was transferred to") instead of "waxaad
 * ... ka heshay" ("you received from"), and the recipient's phone is in
 * parentheses after their name rather than immediately after the amount
 * -- confirmed live: this exact format went completely unrecognized
 * (order DEX254812266's real, successful payout SMS logged as
 * sms_receiver_unrecognized, so the corroboration safety net never fired
 * to correct the on-screen automation's mistaken Failed result). Sender
 * confirmed live too: this SMS arrives in the same thread as sender "192"'s
 * incoming-payment SMS -- the same senders HormuudEvcPlusParser already
 * trusts -- matched on the distinctive "uwareejisay" phrase plus sender,
 * same posture as SomtelEdahabPayoutSentParser.
 */
object HormuudEvcPlusPayoutSentParser : ExchangePayoutSentParser {
    override val senders: List<String> = listOf("192", "EVCPLUS")

    private val pattern = Regex(
        """\$$AMOUNT_PATTERN\s*ayaad\s+uwareejisay\s+.+?\((\d{6,15})\)""",
        RegexOption.IGNORE_CASE
    )

    override fun tryParse(sender: String, body: String): ExchangePayoutConfirmedEntry? {
        if (senders.none { it.equals(sender.trim(), ignoreCase = true) }) return null
        if (!body.contains("uwareejisay", ignoreCase = true)) return null
        val match = pattern.find(body) ?: return null
        val (amount, phone) = match.destructured
        val parsedAmount = parseAmount(amount) ?: return null
        return ExchangePayoutConfirmedEntry(receiverPhone = phone, amount = parsedAmount, provider = "Hormuud", rawText = body)
    }
}

/** Registry for Money Exchange payout confirmations — mirrors [VoucherSentParsers]. */
object ExchangePayoutSentParsers {
    val ALL: List<ExchangePayoutSentParser> = listOf(SomtelEdahabPayoutSentParser, HormuudEvcPlusPayoutSentParser)

    fun parse(sender: String, body: String): ExchangePayoutConfirmedEntry? {
        for (parser in ALL) {
            parser.tryParse(sender, body)?.let { return it }
        }
        return null
    }
}
