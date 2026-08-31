// Shared formatting rules for the raw string actually dialed on an Internet
// Store USSD template (generateUssdForOrder in ussd.routes.ts) — the single
// place that builds a dial string for all five providers (Somnet, Hormuud,
// Somtel, Amtel, SOMLIMK). Kept separate from Money Exchange's own
// normalizePhone/ussdAmountSegments (exchange.routes.ts) deliberately: that
// carrier flow (EVC Plus/eDahab person-to-person transfer, *712*/*110*) was
// live-confirmed to expect dollars and cents as two always-present segments
// (e.g. "1*98", "1*00") — a different menu from the Internet Store top-up
// USSD menus this file targets, which drop the cents segment entirely for a
// whole-dollar amount and drop a trailing zero from a round-tens cents value
// (e.g. "1.00" -> "1", "0.10" -> "0*1", not "1*00"/"0*10"). Do not merge the
// two — they are genuinely different carrier conventions, not a duplicated
// bug.

/** Somali phone numbers are stored/entered with or without the 252 country
 * code or a leading 0, but every Internet Store provider's USSD menu expects
 * the bare 9-digit local number and rejects anything longer (e.g. dialing
 * with "252" still attached delivers the package to a mis-parsed number or
 * is rejected outright by the carrier menu). Same last-9-digit rule already
 * used for SMS/phone matching elsewhere (orders.routes.ts, smsLogs.routes.ts,
 * exchange.routes.ts) — kept as its own copy here rather than importing one
 * of those, since this one's job (format an outgoing dial string) is a
 * distinct concern from theirs (match an incoming SMS sender to a stored
 * number), even though the two currently compute the same thing.
 */
export function normalizePhoneForUssd(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-9);
}

/** Internet Store's provider USSD menus take the amount as whole dollars,
 * optionally followed by a "*"-separated cents segment — never a decimal
 * point ("." isn't a valid USSD/MMI dial character, so a literal "0.10"
 * embedded in the dial string reaches the carrier malformed). Two rules,
 * confirmed against real production examples across all five providers:
 *
 *   1. A whole-dollar amount (cents === 0) omits the cents segment
 *      entirely — "1.00" -> "1", "25.00" -> "25". Never "1*0"/"25*0".
 *   2. A round-tens cents value drops its trailing zero — "0.10" -> "0*1",
 *      "17.50" -> "17*5" — while a cents value that isn't a multiple of 10
 *      keeps both digits — "0.25" -> "0*25", "4.25" -> "4*25".
 *
 * amount is always a NUMERIC(10,2) column value as returned by pg (a decimal
 * string like "0.10" or "25.00"), but Number() handles a raw numeric input
 * identically, so this also accepts a plain number.
 */
export function formatUssdAmount(amount: string | number): string {
  const numeric = Number(amount);
  const dollars = Math.trunc(numeric);
  const cents = Math.round((numeric - dollars) * 100);
  if (cents === 0) return String(dollars);
  const centsSegment = cents % 10 === 0 ? String(cents / 10) : String(cents).padStart(2, "0");
  return `${dollars}*${centsSegment}`;
}
