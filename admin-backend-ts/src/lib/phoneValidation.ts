/**
 * Single source of truth for Somali mobile-number format + carrier-prefix
 * validation on the backend — every route that accepts a phone number a
 * customer, reseller, or agent typed in (as opposed to an admin-configured
 * business/collection number, which keeps its own, separate rules) must
 * validate through this module instead of rolling its own regex.
 *
 * Rules (kept byte-for-byte in sync with customer-app's PhoneValidator
 * (Dart) and agent-app's PhoneValidator (Kotlin) — the three can't literally
 * share one implementation across languages, so all three are hand-kept
 * identical and covered by their own test suite):
 *   - exactly 9 digits, digits only
 *   - must not start with '0'
 *   - the leading 2 digits must be a known carrier prefix
 *   - when a specific wallet/company is given, the prefix must belong to
 *     THAT company specifically, not just any known carrier
 *
 * Company keys match payment_wallets.id exactly (see migration
 * 010_payment_wallets.sql) so this stays aligned with the dial-prefix table
 * already wired everywhere (USSD dial strings, the wallet picker), rather
 * than inventing a second company-naming scheme.
 */

export interface PhoneCompany {
  key: string;
  label: string;
  prefixes: string[];
}

export const PHONE_COMPANIES: readonly PhoneCompany[] = [
  { key: "evc_plus", label: "EVC Plus", prefixes: ["61", "77"] },
  { key: "edahab", label: "Somtel", prefixes: ["62"] },
  { key: "jeeb", label: "Somnet", prefixes: ["68"] },
  { key: "amtel_pay", label: "Amtel", prefixes: ["71"] },
];

const NINE_DIGITS = /^\d{9}$/;

/**
 * Strips everything but digits, then strips one leading "252" country code
 * if present — so "+252617080008", "252617080008" and "617080008" all
 * normalize to the same 9-digit local form before validation. Deliberately
 * does NOT strip a leading '0' — "0617080008" is a real format error
 * (10 digits) the caller must still see, not something to silently fix.
 */
export function normalizeMobileDigits(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.startsWith("252") && digits.length > 9 ? digits.slice(3) : digits;
}

/** Which configured company a 9-digit local number's prefix belongs to, or
 * null if it doesn't match any known carrier prefix. */
export function companyForPrefix(nineDigits: string): PhoneCompany | null {
  return PHONE_COMPANIES.find((c) => c.prefixes.some((p) => nineDigits.startsWith(p))) ?? null;
}

/**
 * Best-effort match from an arbitrary company/wallet name or id (e.g.
 * companies.name, companies.id, company_payment_methods.label,
 * reseller_deposit_methods.method) to one of the 4 known carrier keys.
 * companies.id/company_payment_methods.label are admin-chosen free text,
 * not a fixed enum like payment_wallets.id, so this matches by keyword
 * rather than requiring an exact id equal to one of PHONE_COMPANIES' own
 * keys. Returns null when nothing recognizable is found, in which case the
 * caller should fall back to format-only validation rather than block a
 * legitimate order over a company name this heuristic doesn't recognize.
 */
export function companyKeyFromLabel(nameOrId: string | null | undefined): string | null {
  const s = String(nameOrId ?? "").toLowerCase();
  if (s.includes("hormuud") || s.includes("evc")) return "evc_plus";
  if (s.includes("somtel") || s.includes("edahab")) return "edahab";
  if (s.includes("somnet") || s.includes("jeeb")) return "jeeb";
  if (s.includes("amtel")) return "amtel_pay";
  return null;
}

export interface PhoneValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a raw phone number (any punctuation/spaces/country-code prefix
 * tolerated — see normalizeMobileDigits). When `companyKey` is given (a
 * payment_wallets.id), the number's prefix must belong to that exact
 * company, e.g. the wallet the customer picked or the reseller company the
 * withdrawal/deposit is for; when omitted, any known carrier prefix is
 * accepted (e.g. a customer's own number at registration, where no company
 * is being selected).
 */
export function validateMobileNumber(raw: string | null | undefined, companyKey?: string | null): PhoneValidationResult {
  const digits = normalizeMobileDigits(raw);
  if (!NINE_DIGITS.test(digits) || digits.startsWith("0")) {
    return { valid: false, error: "Invalid phone number. Enter exactly 9 digits." };
  }
  const matchedCompany = companyForPrefix(digits);
  if (!matchedCompany) {
    return { valid: false, error: "Invalid phone number. This prefix is not recognized for any supported carrier." };
  }
  if (companyKey && matchedCompany.key !== companyKey) {
    const expected = PHONE_COMPANIES.find((c) => c.key === companyKey);
    const expectedLabel = expected?.label ?? companyKey;
    const expectedPrefixes = expected?.prefixes.join(" or ") ?? "";
    return {
      valid: false,
      error: `Invalid number. ${expectedLabel} numbers must start with ${expectedPrefixes}.`,
    };
  }
  return { valid: true };
}

export function isValidMobileNumber(raw: string | null | undefined, companyKey?: string | null): boolean {
  return validateMobileNumber(raw, companyKey).valid;
}
