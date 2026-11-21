package com.dalab.internet.ussd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Regression coverage for [WalletNameLookupParser] against every real,
 * on-device USSD response captured so far — see the parser's own doc
 * comment for the exact provenance of each string. The third case
 * (Danwadaag Service / 620220201) is the fix for a live incident: this
 * exact capture came back as a parser failure (no "(<number>)" anywhere in
 * the text at all) until [WalletNameLookupParser] gained a second shape for
 * the "name. Lambarka <number>" sentence structure.
 */
class WalletNameLookupParserTest {

    @Test
    fun `EVC Plus real capture -- name in parens, no lowercase words before it`() {
        val text = "Uwareeji \$1 YASIIN MAXAMED AADAN (610346060), Fadlan..Geli..PIN-kaaga"
        assertEquals("YASIIN MAXAMED AADAN", WalletNameLookupParser.parseRegisteredName(text, "610346060"))
    }

    @Test
    fun `eDahab real capture -- name in parens, lowercase verb phrase before it`() {
        val text = "\$1.00 ayaad u wareejinaysaa Yaasiin Maxamed Aadan (620346060). Geli lambarka sirta ah si aad u xaqiijiso"
        assertEquals("Yaasiin Maxamed Aadan", WalletNameLookupParser.parseRegisteredName(text, "620346060"))
    }

    @Test
    fun `Somtel-eDahab business wallet real capture -- name before a separate Lambarka clause, no parens`() {
        val text = "1 Dollar ayaad u wareejinaysaa Danwadaag Service. Lambarka 620220201 .Lacagta 0.00.Fadlan Geli PIN ka Si aad u Xaqiijiso :"
        assertEquals("Danwadaag Service", WalletNameLookupParser.parseRegisteredName(text, "620220201"))
    }

    @Test
    fun `a second real EVC Plus capture with a different registered name still parses`() {
        val text = "Uwareeji \$1 MAHAD YAASIIN MAXAMED (619991299), Fadlan..Geli..PIN-kaaga"
        assertEquals("MAHAD YAASIIN MAXAMED", WalletNameLookupParser.parseRegisteredName(text, "619991299"))
    }

    @Test
    fun `a well-formed match for the WRONG number is rejected, never falls back to a guess`() {
        val text = "1 Dollar ayaad u wareejinaysaa Danwadaag Service. Lambarka 620220201 .Lacagta 0.00.Fadlan Geli PIN ka Si aad u Xaqiijiso :"
        assertNull(WalletNameLookupParser.parseRegisteredName(text, "999999999"))
    }

    @Test
    fun `the transient carrier loading placeholder never parses as a name`() {
        assertNull(WalletNameLookupParser.parseRegisteredName("USSD code running…", "620220201"))
    }

    @Test
    fun `a bare phone number with no surrounding text never parses as a name`() {
        // The exact symptom of the accessibility service locking onto the
        // wrong window and capturing only the dialed number as "dialog text".
        assertNull(WalletNameLookupParser.parseRegisteredName("620220201", "620220201"))
    }

    @Test
    fun `a single capitalized word is never trusted as a full registered name`() {
        val text = "1 Dollar ayaad u wareejinaysaa Service. Lambarka 620220201 .Lacagta 0.00"
        assertNull(WalletNameLookupParser.parseRegisteredName(text, "620220201"))
    }
}
