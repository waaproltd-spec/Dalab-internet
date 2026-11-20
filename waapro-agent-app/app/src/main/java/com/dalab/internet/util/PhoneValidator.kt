package com.dalab.internet.util

/**
 * Single source of truth for Somali mobile-number format + carrier-prefix
 * validation across the Agent App — every screen that accepts a phone
 * number a customer/agent types (New Sale, Add Customer) must validate
 * through this file instead of rolling its own regex/length check.
 *
 * Rules (kept byte-for-byte in sync with admin-backend-ts's
 * phoneValidation.ts and customer-app's PhoneValidator (Dart) — the three
 * can't literally share one implementation across languages, so all three
 * are hand-kept identical and covered by their own test suite):
 *   - exactly 9 digits, digits only
 *   - must not start with '0'
 *   - the leading 2 digits must be a known carrier prefix
 *   - when a specific wallet/company is given, the prefix must belong to
 *     THAT company specifically, not just any known carrier
 *
 * Company keys match payment_wallets.id exactly (see admin-backend-ts
 * migration 010_payment_wallets.sql) so this stays aligned with the
 * dial-prefix table already wired everywhere, rather than inventing a
 * second company-naming scheme.
 */

data class PhoneCompany(val key: String, val label: String, val prefixes: List<String>)

val PHONE_COMPANIES: List<PhoneCompany> = listOf(
    PhoneCompany("evc_plus", "EVC Plus", listOf("61", "77")),
    PhoneCompany("edahab", "Somtel", listOf("62")),
    PhoneCompany("jeeb", "Somnet", listOf("68")),
    PhoneCompany("amtel_pay", "Amtel", listOf("71")),
    // Somlink is topped up over its own network (prefix 64) but paid for
    // through the existing EVC Plus wallet -- unlike the four above, this
    // key has no corresponding payment_wallets row, since it's a
    // destination carrier only, never itself a payment method. Matches
    // the identical fix in admin-backend-ts's phoneValidation.ts and
    // customer-app's phone_validator.dart.
    PhoneCompany("somlink", "Somlink", listOf("64")),
)

private val NINE_DIGITS = Regex("^\\d{9}$")
private val NON_DIGIT = Regex("\\D")

/** Strips everything but digits -- does NOT strip a leading "252" country
 * code. Product decision: a customer/agent typing "252617080008" must be
 * told to re-enter it as "617080008" and learn the correct format, not
 * have it silently accepted as if typed correctly (see
 * [validateMobileNumber]'s dedicated 252 check, which fires before this
 * would even matter). Also deliberately does NOT strip a leading '0' --
 * "0617080008" is a real format error (10 digits) the caller must still
 * see, not something to silently fix. */
fun normalizeMobileDigits(raw: String?): String = (raw ?: "").replace(NON_DIGIT, "")

/** Which configured company a 9-digit local number's prefix belongs to, or
 * null if it doesn't match any known carrier prefix. */
fun companyForPrefix(nineDigits: String): PhoneCompany? =
    PHONE_COMPANIES.firstOrNull { company -> company.prefixes.any { nineDigits.startsWith(it) } }

data class PhoneValidationResult(val valid: Boolean, val error: String? = null)

/** Best-effort match from an arbitrary company/wallet display name to one
 * of the 4 known carrier keys -- company names are admin-chosen free text,
 * not a fixed enum like [PHONE_COMPANIES]' own keys, so this matches by
 * keyword rather than requiring an exact match. Returns null when nothing
 * recognizable is found, in which case the caller should fall back to
 * format-only validation (omit companyKey) rather than block a legitimate
 * entry over a company name this heuristic doesn't recognize. */
fun companyKeyFromLabel(nameOrId: String?): String? {
    val s = (nameOrId ?: "").lowercase()
    return when {
        s.contains("hormuud") || s.contains("evc") -> "evc_plus"
        s.contains("somtel") || s.contains("edahab") -> "edahab"
        s.contains("somnet") || s.contains("jeeb") -> "jeeb"
        s.contains("amtel") -> "amtel_pay"
        s.contains("somlimk") || s.contains("somlink") -> "somlink"
        else -> null
    }
}

/**
 * Validates a raw phone number (any punctuation/spaces/country-code prefix
 * tolerated -- see [normalizeMobileDigits]). When [companyKey] is given (a
 * payment_wallets.id), the number's prefix must belong to that exact
 * company; when omitted, any known carrier prefix is accepted.
 */
fun validateMobileNumber(raw: String?, companyKey: String? = null): PhoneValidationResult {
    val digits = normalizeMobileDigits(raw)
    // No valid 9-digit local number can ever start with "252" (every known
    // carrier prefix -- 61/77/62/68/71 -- starts with 6 or 7), so this is
    // always the customer's own country code leaking into the field, never
    // a coincidental real number. Checked before the generic 9-digit check
    // specifically so this gets its own clear, teachable message instead of
    // the generic "enter exactly 9 digits" one.
    if (digits.startsWith("252")) {
        return PhoneValidationResult(
            valid = false,
            error = "Enter your number as 9 digits without the 252 country code, e.g. 617080008 — not 252617080008.",
        )
    }
    if (!NINE_DIGITS.matches(digits) || digits.startsWith("0")) {
        return PhoneValidationResult(valid = false, error = "Invalid phone number. Enter exactly 9 digits.")
    }
    val matchedCompany = companyForPrefix(digits)
        ?: return PhoneValidationResult(valid = false, error = "Invalid phone number. This prefix is not recognized for any supported carrier.")
    if (companyKey != null && matchedCompany.key != companyKey) {
        val expected = PHONE_COMPANIES.firstOrNull { it.key == companyKey }
        val expectedLabel = expected?.label ?: companyKey
        val expectedPrefixes = expected?.prefixes?.joinToString(" or ") ?: ""
        return PhoneValidationResult(valid = false, error = "Invalid number. $expectedLabel numbers must start with $expectedPrefixes.")
    }
    return PhoneValidationResult(valid = true)
}

fun isValidMobileNumber(raw: String?, companyKey: String? = null): Boolean = validateMobileNumber(raw, companyKey).valid
