import { ParsedPaymentSms, RawSms, TelecomOperator } from "../types/sms";

/**
 * One parser per operator's payment-confirmation SMS format. Each parser is
 * responsible for BOTH recognizing its own sender IDs AND validating that the
 * message body genuinely matches the confirmation format — this is what lets
 * the hook honestly claim "only process SMS messages related to payment
 * confirmations, do not read/store/upload unrelated SMS": every other
 * message on the device fails every parser's test() and is discarded before
 * anything is logged or uploaded.
 */
export interface OperatorSmsParser {
  operator: TelecomOperator;
  senderIds: string[];
  /** Cheap first check: does this sender/body combination even belong to this parser? */
  matchesSender(sender: string): boolean;
  /** Full validation + extraction. Returns null if the body isn't a genuine, well-formed confirmation. */
  tryParse(raw: RawSms): ParsedPaymentSms | null;
}

function normalizeSender(sender: string): string {
  return sender.replace(/\s+/g, "").toUpperCase();
}

/**
 * Hormuud EVC Plus — confirmed real format (from the project's own SMS sample):
 *   "[-EVCPLUS-] waxaad $1 ka heshay 0610346060, Tar: 24/07/26"
 * Sender: "192" or "EVCPLUS"
 * Same pattern already implemented in the native Agent App's Kotlin parser —
 * kept identical here so both clients agree on what counts as valid.
 */
export const hormuudParser: OperatorSmsParser = {
  operator: "Hormuud",
  senderIds: ["192", "EVCPLUS"],
  matchesSender(sender) {
    const s = normalizeSender(sender);
    return this.senderIds.some((id) => s === id || s.includes(id));
  },
  tryParse(raw) {
    if (!this.matchesSender(raw.sender)) return null;
    const match = raw.body.match(
      /waxaad\s+\$?\s*([\d.]+)\s*\$?\s*ka\s+heshay\s+(\d{6,12}),?\s*Tar:\s*([\d/]+)/i
    );
    if (!match) return null;
    const [, amountStr, phone, dateStr] = match;
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    return {
      operator: "Hormuud",
      customerPhone: phone,
      amount,
      transactionDateTime: parseDdMmYy(dateStr) ?? new Date(raw.timestampMs).toISOString(),
      rawSender: raw.sender,
      rawBody: raw.body,
    };
  },
};

/**
 * UNCONFIRMED — placeholder pending a real sample SMS from Somnet (JEEB).
 * The pattern below is a reasonable guess based on the Hormuud format and
 * common JEEB confirmation wording, but it has NOT been verified against a
 * real message the way the Hormuud parser has. Treat matchesSender/tryParse
 * here as "ready to wire up the moment a real sample arrives" rather than
 * "known correct" — do not rely on this in production without confirming
 * the actual format first.
 */
export const somnetParser: OperatorSmsParser = {
  operator: "Somnet",
  senderIds: ["JEEB", "SOMNET"],
  matchesSender(sender) {
    const s = normalizeSender(sender);
    return this.senderIds.some((id) => s === id || s.includes(id));
  },
  tryParse(raw) {
    if (!this.matchesSender(raw.sender)) return null;
    const match = raw.body.match(/received\s+\$?([\d.]+)\s+from\s+(\d{6,12})/i);
    if (!match) return null;
    const [, amountStr, phone] = match;
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return {
      operator: "Somnet",
      customerPhone: phone,
      amount,
      transactionDateTime: new Date(raw.timestampMs).toISOString(),
      rawSender: raw.sender,
      rawBody: raw.body,
    };
  },
};

/** UNCONFIRMED placeholder — same caveat as somnetParser above (eDahab). */
export const somtelParser: OperatorSmsParser = {
  operator: "Somtel",
  senderIds: ["EDAHAB", "SOMTEL"],
  matchesSender(sender) {
    const s = normalizeSender(sender);
    return this.senderIds.some((id) => s === id || s.includes(id));
  },
  tryParse(raw) {
    if (!this.matchesSender(raw.sender)) return null;
    const match = raw.body.match(/received\s+\$?([\d.]+)\s+from\s+(\d{6,12})/i);
    if (!match) return null;
    const [, amountStr, phone] = match;
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return {
      operator: "Somtel",
      customerPhone: phone,
      amount,
      transactionDateTime: new Date(raw.timestampMs).toISOString(),
      rawSender: raw.sender,
      rawBody: raw.body,
    };
  },
};

/** UNCONFIRMED placeholder — same caveat as somnetParser above (Amtel). */
export const amtelParser: OperatorSmsParser = {
  operator: "Amtel",
  senderIds: ["AMTEL"],
  matchesSender(sender) {
    const s = normalizeSender(sender);
    return this.senderIds.some((id) => s === id || s.includes(id));
  },
  tryParse(raw) {
    if (!this.matchesSender(raw.sender)) return null;
    const match = raw.body.match(/received\s+\$?([\d.]+)\s+from\s+(\d{6,12})/i);
    if (!match) return null;
    const [, amountStr, phone] = match;
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return {
      operator: "Amtel",
      customerPhone: phone,
      amount,
      transactionDateTime: new Date(raw.timestampMs).toISOString(),
      rawSender: raw.sender,
      rawBody: raw.body,
    };
  },
};

export const OPERATOR_PARSERS: OperatorSmsParser[] = [hormuudParser, somnetParser, somtelParser, amtelParser];

/**
 * Reseller Withdraw ("Lacag Bixi") OUTGOING confirmations — the reseller
 * sent money OUT to a customer (via the existing "Dial to Pay" send-money
 * USSD), and this is the telecom's own "you sent $X to Y" SMS back. Kept
 * as a completely separate registry from OPERATOR_PARSERS above (which are
 * all "you RECEIVED $X from Y" — the opposite direction, used for Internet
 * Store/eBadal/Reseller Deposit) — reusing ParsedPaymentSms's shape is fine
 * (the wire format to POST /agent/sms-logs is direction-agnostic; the
 * backend's ingestPaymentSms decides what a given amount+phone means by
 * which matcher — Deposit vs Withdraw — actually claims it), but the
 * PARSING itself must never be shared between companies whose real SMS
 * formats differ, confirmed against real samples for exactly two operators
 * so far. Somtel/Somnet have no confirmed outgoing sample yet — do not add
 * placeholder/guessed parsers for them; an unconfirmed regex risks either
 * silently never matching (harmless) or, worse, matching the wrong SMS.
 */

/**
 * Hormuud E-Voucher (EVC Plus) send-money confirmation — confirmed real
 * format (from the project's own SMS sample):
 *   "[-E-Voucher-] $0.5 ayaad uwareejisay YAASIIN MAXAMED AADAN(617080008), Haraagaagu waa $2.37."
 * Sender: "740". Distinct from hormuudParser above (sender "192"/"EVCPLUS",
 * "waxaad ... ka heshay" — received wording) — different sender ID AND
 * different wording, so there is no ambiguity between the two directions.
 */
export const hormuudOutgoingParser: OperatorSmsParser = {
  operator: "Hormuud",
  senderIds: ["740"],
  matchesSender(sender) {
    const s = normalizeSender(sender);
    return this.senderIds.some((id) => s === id || s.includes(id));
  },
  tryParse(raw) {
    if (!this.matchesSender(raw.sender)) return null;
    const match = raw.body.match(
      /\$?([\d.]+)\s*ayaad\s+uwareejisay\s+(.+?)\((\d{6,12})\),?\s*Haraagaagu\s+waa\s*\$?([\d.]+)/i
    );
    if (!match) return null;
    const [, amountStr, , phone] = match;
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    return {
      operator: "Hormuud",
      customerPhone: phone,
      amount,
      transactionDateTime: new Date(raw.timestampMs).toISOString(),
      rawSender: raw.sender,
      rawBody: raw.body,
    };
  },
};

/**
 * Amtel send-money confirmation — confirmed real format (from the
 * project's own SMS sample):
 *   "You have transferred $1-252711444497. Date-Time: 18/08/2026 09:04:48. Transaction ID: 04247700000025841807. Your balance $0.35."
 * Sender: "913". Distinct from amtelParser above (sender "AMTEL", the
 * "received $X from Y" placeholder wording).
 */
export const amtelOutgoingParser: OperatorSmsParser = {
  operator: "Amtel",
  senderIds: ["913"],
  matchesSender(sender) {
    const s = normalizeSender(sender);
    return this.senderIds.some((id) => s === id || s.includes(id));
  },
  tryParse(raw) {
    if (!this.matchesSender(raw.sender)) return null;
    const match = raw.body.match(
      /You have transferred\s*\$?([\d.]+)-(\d{6,15})\.\s*Date-Time:\s*([\d/]+\s+[\d:]+)\.\s*Transaction ID:\s*([^.\s]+)\.\s*Your balance\s*\$?([\d.]+)/i
    );
    if (!match) return null;
    const [, amountStr, phone, dateTimeStr] = match;
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    return {
      operator: "Amtel",
      customerPhone: phone,
      amount,
      transactionDateTime: parseDdMmYyyyHms(dateTimeStr) ?? new Date(raw.timestampMs).toISOString(),
      rawSender: raw.sender,
      rawBody: raw.body,
    };
  },
};

export const OUTGOING_OPERATOR_PARSERS: OperatorSmsParser[] = [hormuudOutgoingParser, amtelOutgoingParser];

/**
 * Tries every registered RECEIVED-payment parser first, then every
 * registered SENT-payment (Withdraw) parser. Returns null for anything
 * that isn't a recognized, well-formed confirmation of either direction —
 * this is the single enforcement point for "only process payment
 * confirmation SMS, ignore everything else" (see useSMSListener.ts, which
 * discards non-matches before they're ever logged or uploaded).
 */
export function parsePaymentSms(raw: RawSms): ParsedPaymentSms | null {
  for (const parser of OPERATOR_PARSERS) {
    if (!parser.matchesSender(raw.sender)) continue;
    const result = parser.tryParse(raw);
    if (result) return result;
  }
  for (const parser of OUTGOING_OPERATOR_PARSERS) {
    if (!parser.matchesSender(raw.sender)) continue;
    const result = parser.tryParse(raw);
    if (result) return result;
  }
  return null;
}

/** "18/08/2026 09:04:48" -> ISO string, best-effort; returns null if unparseable. */
function parseDdMmYyyyHms(input: string): string | null {
  const dateMatch = input.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!dateMatch) return null;
  const [, dayStr, monthStr, yearStr, hourStr, minuteStr, secondStr] = dateMatch;
  const date = new Date(
    Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr), Number(hourStr), Number(minuteStr), Number(secondStr))
  );
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** "24/07/26" -> ISO string, best-effort; returns null if unparseable. */
function parseDdMmYy(input: string): string | null {
  const parts = input.split("/").map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [day, month, yearShort] = parts;
  const year = yearShort < 100 ? 2000 + yearShort : yearShort;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
