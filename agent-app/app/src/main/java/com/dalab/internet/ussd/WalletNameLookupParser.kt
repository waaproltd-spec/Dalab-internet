package com.dalab.internet.ussd

/**
 * Extracts the carrier's own registered account name from a Wallet Name
 * Lookup's pre-PIN USSD response text — the same text
 * ExchangeUssdOrchestrator's real payouts already read as `firstEvent.text`,
 * just parsed here instead of being paired with a PIN. Fail-safe by design
 * (the product's own explicit safety rule): returns null on ANYTHING that
 * isn't a confident, positively-matched name for the exact number being
 * looked up — never a partial guess, never the carrier's own literal
 * instruction text ("Geli PIN-kaaga"), never a name captured for a
 * different number than the one this lookup was started for.
 *
 * BOTH formats below are CONFIRMED against real on-device captures
 * (2026-09-18/09-19):
 *   - EVC Plus (Hormuud): "Uwareeji $1 YASIIN MAXAMED AADAN (610346060),
 *     Fadlan..Geli..PIN-kaaga"
 *   - eDahab: "$1.00 ayaad u wareejinaysaa Yaasiin Maxamed Aadan
 *     (620346060). Geli lambarka sirta ah si aad u xaqiijiso"
 *
 * The two carriers' surrounding Somali sentences differ, and critically,
 * EVC Plus's carries no lowercase words between the name and "(<number>)"
 * while eDahab's does ("ayaad u wareejinaysaa" directly precedes the name).
 * An early version of this parser matched "whatever text precedes
 * (<digits>)" — correct for EVC Plus purely by luck (the "$1" amount token
 * happens to block the match from reaching further back), but WRONG for
 * eDahab: it would have captured "ayaad u wareejinaysaa Yaasiin Maxamed
 * Aadan" (the verb phrase included) as the "name". Fixed by requiring the
 * captured name to be a run of CAPITALIZED words specifically (each word
 * starting with an uppercase letter) immediately before "(<digits>)" —
 * every Somali grammatical word in both real captures ("ayaad", "u",
 * "wareejinaysaa", "Fadlan"'s own siblings, etc.) starts lowercase, while a
 * real person's name's words are always capitalized (either Title Case, as
 * eDahab renders it, or full caps, as EVC Plus renders it) — so this
 * naturally stops at the name's actual start regardless of what
 * carrier-specific phrasing precedes it.
 */
object WalletNameLookupParser {

    // Up to 5 consecutive capitalized words (each: an uppercase letter, then
    // any run of letters/apostrophes/hyphens), immediately followed by
    // "(<6-12 digits>)" allowing only whitespace in between.
    private val NAME_NUMBER_REGEX = Regex("""((?:[A-Z][A-Za-z'-]*\s+){0,4}[A-Z][A-Za-z'-]*)\s*\((\d{6,12})\)""")

    /**
     * [rawText] is the full USSD prompt text as read by the accessibility
     * service. [expectedPhoneNumber] is the number this lookup was actually
     * started for (any digit-containing format — only its last 9 digits are
     * compared). Returns the registered name only if the response contains
     * a "<CapitalizedWords> (<number>)" shape whose number matches
     * [expectedPhoneNumber] — guarding against a stray, unrelated dialog
     * being misread as this lookup's answer — and the name has at least two
     * words (a bare single capitalized word right before a parenthesized
     * number is more likely a coincidental match than a full registered
     * name). Returns null for everything else, including a well-formed
     * match for the WRONG number: callers must treat null the same as any
     * other failed lookup, never fall back to a lower-confidence guess.
     */
    fun parseRegisteredName(rawText: String, expectedPhoneNumber: String): String? {
        val expectedLast9 = expectedPhoneNumber.filter { it.isDigit() }.takeLast(9)
        if (expectedLast9.length != 9) return null

        val match = NAME_NUMBER_REGEX.find(rawText) ?: return null
        val candidateName = match.groupValues[1].trim()
        val candidateNumber = match.groupValues[2].filter { it.isDigit() }.takeLast(9)

        if (candidateNumber != expectedLast9) return null
        if (candidateName.split(Regex("\\s+")).size < 2) return null

        return candidateName
    }
}
