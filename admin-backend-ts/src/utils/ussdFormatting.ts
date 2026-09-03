// Shared formatting rules for the raw string actually dialed on an Internet
// Store USSD template (generateUssdForOrder in ussd.routes.ts) — the single
// place that builds a dial string for all five providers (Somnet, Hormuud,
// Somtel, Amtel, SOMLIMK). Kept separate from Money Exchange's own
// normalizePhone/ussdAmountSegments (exchange.routes.ts) deliberately: that
// carrier flow (EVC Plus/eDahab person-to-person transfer, *712*/*110*) was
// live-confirmed to expect dollars and cents as two always-present, "*"-
// SEPARATED segments (e.g. "1*98", "1*00") in its own multi-field menu — a
// genuinely different carrier convention from the Internet Store top-up USSD
// menus this file targets. Internet Store's templates (e.g. Hormuud Anfac's
// "*737*{number}*{amount}*{pin}#") have exactly ONE {amount} placeholder — a
// single dial-string field — so the amount must always collapse to ONE
// token, never an internal "*"-split value: splitting it turns a 4-field
// dial string into 5 and the carrier rejects it outright as malformed (real
// incident: production order DLB957571658, Hormuud Anfac $0.10, dialed as
// "*737*610808086*0*1*<pin>#" — Hormuud's own error response literally
// quoted the expected 4-field "*737*number*lacag*pin#" shape back). Confirmed
// by real completed-order history (ussd_logs.generated_string, Hormuud, Aug
// 2026): $0.10 -> "01" (7 completions, both channels) and $0.50 -> "05" (1
// completion) — both a single concatenated token, never "0*1"/"0*5". Do not
// reintroduce a "*" inside the amount token.

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

/** Internet Store's provider USSD menus take the amount as a SINGLE dial-
 * string token — never a decimal point ("." isn't a valid USSD/MMI dial
 * character, so a literal "0.10" embedded in the dial string reaches the
 * carrier malformed) and never split across two "*"-separated fields (the
 * template has only one {amount} placeholder; splitting it changes the
 * carrier-visible field count and gets rejected — see this file's header
 * comment for the real incident this was confirmed against). Two rules:
 *
 *   1. A whole-dollar amount (cents === 0) is just the dollar figure —
 *      "1.00" -> "1", "25.00" -> "25". Never "1*0"/"25*0"/"10"/"250".
 *   2. A fractional amount concatenates dollars with the cents figure into
 *      ONE token, dropping a round-tens cents value's trailing zero first —
 *      "0.10" -> "01", "0.50" -> "05", "17.50" -> "175" — while a cents
 *      value that isn't a multiple of 10 keeps both digits — "0.25" -> "025",
 *      "4.25" -> "425". Never insert a "*" between the dollars and cents
 *      figures.
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
  return `${dollars}${centsSegment}`;
}
