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
 * THREE formats below are CONFIRMED against real on-device captures
 * (2026-09-18/09-19):
 *   - EVC Plus (Hormuud): "Uwareeji $1 YASIIN MAXAMED AADAN (610346060),
 *     Fadlan..Geli..PIN-kaaga"
 *   - eDahab: "$1.00 ayaad u wareejinaysaa Yaasiin Maxamed Aadan
 *     (620346060). Geli lambarka sirta ah si aad u xaqiijiso"
 *   - Somtel/another eDahab-family template (business-registered wallet):
 *     "1 Dollar ayaad u wareejinaysaa Danwadaag Service. Lambarka
 *     620220201 .Lacagta 0.00.Fadlan Geli PIN ka Si aad u Xaqiijiso :"
 *
 * The carriers' surrounding Somali sentences differ in two ways that
 * matter here: which lowercase words (if any) precede the name, and where
 * the number appears relative to it. EVC Plus and the second eDahab
 * template both put the number in parentheses immediately after the name
 * ([NAME_BEFORE_PARENS_REGEX]); the third puts the name and number in two
 * separate clauses joined by "Lambarka" (Somali "the number") with no
 * parentheses at all ([NAME_BEFORE_LAMBARKA_REGEX]) — a real capture for
 * 620220201 came back as a parser failure (no name extracted, lookup
 * reported "failed") until this second shape was added. Both regexes
 * require the captured name to be a run of CAPITALIZED words specifically
 * (each word starting with an uppercase letter): every Somali grammatical
 * word in every real capture so far ("ayaad", "u", "wareejinaysaa",
 * "Fadlan"'s own siblings, "Lambarka", "Lacagta", etc.) starts lowercase or
 * is itself the literal anchor being matched on, while a real registered
 * name's words — a person's or a business's — are always capitalized
 * (either Title Case or full caps) — so this naturally stops at the name's
 * actual start regardless of what carrier-specific phrasing precedes it,
 * and works the same whether the name is a person or, as in the third
 * example, a business ("Danwadaag Service").
 */
object WalletNameLookupParser {

    // Up to 5 consecutive capitalized words (each: an uppercase letter, then
    // any run of letters/apostrophes/hyphens), immediately followed by
    // "(<6-12 digits>)" allowing only whitespace in between.
    private val NAME_BEFORE_PARENS_REGEX = Regex("""((?:[A-Z][A-Za-z'-]*\s+){0,4}[A-Z][A-Za-z'-]*)\s*\((\d{6,12})\)""")

    // Same name shape, but followed by its own sentence ("Danwadaag
    // Service.") and the number given afterward as a separate "Lambarka
    // <digits>" clause instead of in parentheses.
    private val NAME_BEFORE_LAMBARKA_REGEX = Regex("""((?:[A-Z][A-Za-z'-]*\s+){0,4}[A-Z][A-Za-z'-]*)\.?\s*Lambarka\s+(\d{6,12})""")

    /**
     * [rawText] is the full USSD prompt text as read by the accessibility
     * service. [expectedPhoneNumber] is the number this lookup was actually
     * started for (any digit-containing format — only its last 9 digits are
     * compared). Returns the registered name only if the response contains
     * one of the two confirmed "<CapitalizedWords> ... <number>" shapes
     * (see class doc) whose number matches [expectedPhoneNumber] —
     * guarding against a stray, unrelated dialog being misread as this
     * lookup's answer — and the name has at least two words (a bare single
     * capitalized word right before the number is more likely a
     * coincidental match than a full registered name). Returns null for
     * everything else, including a well-formed match for the WRONG number:
     * callers must treat null the same as any other failed lookup, never
     * fall back to a lower-confidence guess.
     */
    fun parseRegisteredName(rawText: String, expectedPhoneNumber: String): String? {
        val expectedLast9 = expectedPhoneNumber.filter { it.isDigit() }.takeLast(9)
        if (expectedLast9.length != 9) return null

        val match = NAME_BEFORE_PARENS_REGEX.find(rawText) ?: NAME_BEFORE_LAMBARKA_REGEX.find(rawText) ?: return null
        val candidateName = match.groupValues[1].trim()
        val candidateNumber = match.groupValues[2].filter { it.isDigit() }.takeLast(9)

        if (candidateNumber != expectedLast9) return null
        if (candidateName.split(Regex("\\s+")).size < 2) return null

        return candidateName
    }
}
