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

/** For the minority of Internet Store providers whose top-up USSD menu takes
 * the amount as its own dial-string field ONLY when there are cents — a
 * whole-dollar amount has no second field at all, not even a "*0" — unlike
 * splitUssdAmount()/{amountWhole}+{amountCents} below, which always emits
 * both fields. Confirmed against a real stuck order (DLB637490120, Somtel
 * "Unlimited Data & Voice", provider amount $17.50): formatUssdAmount's
 * single-token "175" and a raw "17.5" both left the order permanently stuck
 * "ambiguous" after 3 dial attempts on an online device — Somtel's *831*
 * menu for this package needs "17*5", not "175" or "17*50". Same
 * trailing-zero-collapse rule as formatUssdAmount's cents segment (50 cents
 * -> "5", 25 cents -> "25"), just "*"-joined to the whole-dollar figure
 * instead of concatenated, and entirely omitted (no separator, no "0") when
 * there are no cents:
 *
 *   17.00 -> "17"      (no second field)
 *   17.50 -> "17*5"    (not "175", not "17*50")
 *   17.25 -> "17*25"
 *   12.34 -> "12*34"
 *    1.50 -> "1*5"
 *
 * Substituted into a single {amountSplit} placeholder — the "*" lives inside
 * the substituted value itself, so the template around it stays a single
 * placeholder shape, same as {amount} above, not a fixed two-field shape
 * like {amountWhole}/{amountCents}.
 */
export function formatUssdAmountSplit(amount: string | number): string {
  const numeric = Number(amount);
  const dollars = Math.trunc(numeric);
  const cents = Math.round((numeric - dollars) * 100);
  if (cents === 0) return String(dollars);
  const centsSegment = cents % 10 === 0 ? String(cents / 10) : String(cents).padStart(2, "0");
  return `${dollars}*${centsSegment}`;
}

/** For the minority of Internet Store providers whose top-up USSD menu
 * takes the amount as its OWN two separate dial-string fields rather than
 * formatUssdAmount()'s single collapsed token above — confirmed live for
 * Somnet's top-up code, whose own carrier error response (production order
 * DLB981226132, $22.50, dialed with the single-token format and rejected
 * outright) quoted back the expected shape as "*827*number*lacag*cents#":
 * a genuinely separate "lacag" (whole amount) and "cents" field, unlike
 * Hormuud/Somtel/Amtel's templates. Exposed as its own {amountWhole}/
 * {amountCents} placeholder pair in generateUssdForOrder rather than
 * changing formatUssdAmount()/{amount} itself, so this is purely additive:
 * every existing single-token template for every other provider is
 * completely unaffected. Cents is always exactly 2 digits (never the
 * trailing-zero-dropped shorthand formatUssdAmount uses) since here it's a
 * standalone field, not concatenated into one token — same convention as
 * formatEvcDahabUssdAmount above. */
export function splitUssdAmount(amount: string | number): { whole: string; cents: string } {
  const numeric = Number(amount);
  const whole = Math.trunc(numeric);
  const cents = Math.round((numeric - whole) * 100);
  return { whole: String(whole), cents: String(cents).padStart(2, "0") };
}

/** EVC Plus / eDahab's own Dial-to-Pay USSD menu (dial prefixes "*712*" and
 * "*110*", shop_payment_methods.ussd_template e.g. "*712*610338686*{amount}#")
 * is a genuinely different carrier convention from formatUssdAmount() above
 * and must never use it — that one is for Internet Store's single-token
 * top-up templates only (see its own header comment). This is the shared
 * implementation for every EVC Plus/eDahab dial string in the app — Money
 * Exchange payouts, Shop, VIP Numbers: "." is not a valid GSM/USSD MMI dial
 * character, so a decimal amount like "22.20" embedded directly in the dial
 * string never reaches the carrier intact — confirmed live against the real
 * *712*...# payout flow, which flattened "1.98" into "198" (misread as
 * $198, a 100x error) every time. For an amount with cents, the carrier's
 * own two-step Dial-to-Pay menu instead expects the amount as two separate
 * *-delimited segments, whole dollars then cents — also confirmed live:
 * dialing "*712*<number>*1*98#" correctly showed "$1.98" in the carrier's
 * own confirmation text.
 *
 * A WHOLE-DOLLAR amount must never get a spurious "*00" cents segment
 * appended, the same rule formatUssdAmount()/formatUssdAmountSplit() above
 * already apply — live-confirmed broken: a real $42.00 VIP Number order
 * dialed as "*712*610338686*42*00#" (the previous unconditional split
 * below), an extra empty-looking field the carrier's menu doesn't expect
 * for a round amount. Three cases:
 *
 *   1. No cents (cents === 0): just the dollar figure — "42.00" -> "42",
 *      "1.00" -> "1". Never "42*00"/"1*00".
 *   2. Cents but no dollars (a sub-$1 amount): just the 2-digit cents
 *      figure alone, no leading "0*" — "0.05" -> "05", "0.50" -> "50".
 *      Never "0*05".
 *   3. Both dollars and cents: the two *-delimited segments as before —
 *      "1.05" -> "1*05", "1.98" -> "1*98".
 *
 * amount is always a NUMERIC(10,2) column value as returned by pg (a
 * decimal string like "0.10" or "25.00"), but Number() handles a raw
 * numeric input identically — same numeric (not string-split) approach as
 * formatUssdAmount() above, which also avoids a naive string amount ever
 * arriving without a decimal point in the first place. */
export function formatEvcDahabUssdAmount(amount: string | number): string {
  const numeric = Number(amount);
  const dollars = Math.trunc(numeric);
  const cents = Math.round((numeric - dollars) * 100);
  if (cents === 0) return String(dollars);
  const centsSegment = String(cents).padStart(2, "0");
  return dollars === 0 ? centsSegment : `${dollars}*${centsSegment}`;
}
