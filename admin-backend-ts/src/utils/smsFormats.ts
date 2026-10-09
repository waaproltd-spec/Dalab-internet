import { query } from "../db/pool.js";

/**
 * SMS Format Update: reading rules for incoming-payment SMS that the Super
 * Admin can replace from the dashboard when a provider changes its wording.
 *
 * A rule is one regex plus which capture group holds which field, the
 * keywords that must appear in the SMS, and the sender IDs it may come from.
 * The SAME rule runs in two places -- here (the dashboard's Test SMS, and a
 * fallback for SMS an Agent App uploaded unparsed) and in the Agent App
 * (DynamicSmsFormats.kt, on java.util.regex) -- so generated and
 * hand-edited patterns are limited to syntax both engines read identically
 * (see validatePattern).
 *
 * Reading an SMS only extracts amount / payer number / reference. Whether
 * that is a real payment for a real order is still decided by the normal
 * matching + verification pipeline (smsLogs.routes.ts), unchanged.
 */

export type SmsFormatProvider = {
  key: string;
  label: string;
  /** What the existing matching pipeline expects in sms_logs.parsed_provider. */
  parsedProvider: string;
  /** sms_sender_ids.provider_key whose senders this provider's SMS come from. */
  senderKey: string;
  defaultSenders: string[];
};

export const SMS_FORMAT_PROVIDERS: SmsFormatProvider[] = [
  { key: "edahab", label: "eDahab", parsedProvider: "Somtel", senderKey: "somtel_edahab", defaultSenders: ["eDahab"] },
  { key: "evc_plus", label: "EVC Plus", parsedProvider: "Hormuud", senderKey: "hormuud_evc_plus", defaultSenders: ["192", "EVCPLUS"] },
  { key: "hormuud", label: "Hormuud", parsedProvider: "Hormuud", senderKey: "hormuud_evc_plus", defaultSenders: ["192", "EVCPLUS"] },
  { key: "somtel", label: "Somtel", parsedProvider: "Somtel", senderKey: "somtel_edahab", defaultSenders: ["eDahab"] },
  { key: "somnet", label: "Somnet", parsedProvider: "Somnet", senderKey: "somnet_evc_plus", defaultSenders: ["192"] },
  { key: "amtel", label: "Amtel", parsedProvider: "Amtel", senderKey: "amtel", defaultSenders: [] },
];

export function providerByKey(key: unknown): SmsFormatProvider | undefined {
  return SMS_FORMAT_PROVIDERS.find((p) => p.key === key);
}

export type SmsFormatRule = {
  pattern: string;
  amountGroup: number;
  senderGroup: number;
  referenceGroup: number | null;
  recipientGroup: number | null;
  keywords: string[];
  senders: string[];
};

export type Extracted = {
  amount: number;
  senderPhone: string;
  reference: string | null;
  recipientPhone: string | null;
};

export type ApplyResult = { ok: true; extracted: Extracted } | { ok: false; reason: string };

export const MAX_SMS_LENGTH = 2000;
const MAX_PATTERN_LENGTH = 800;

/** Same normalization the Agent App applies before reading an SMS. */
export function normalizeSms(body: string): string {
  return body.replace(/\u00A0/g, " ").slice(0, MAX_SMS_LENGTH);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function hasKeywords(body: string, keywords: string[]): string | null {
  const haystack = collapse(body);
  for (const k of keywords) {
    if (!haystack.includes(collapse(k))) return k;
  }
  return null;
}

/**
 * Rejects anything java.util.regex and JavaScript would read differently,
 * plus the constructs that make catastrophic backtracking possible.
 */
export function validatePattern(pattern: string): string | null {
  if (!pattern || typeof pattern !== "string") return "The pattern is empty.";
  if (pattern.length > MAX_PATTERN_LENGTH) return `The pattern is too long (max ${MAX_PATTERN_LENGTH} characters).`;
  if (/\(\?<[=!]/.test(pattern)) return "Look-behind (?<= / (?<! is not allowed.";
  if (/\\[1-9]|\\k</.test(pattern)) return "Back-references are not allowed.";
  if (/\\[pPuxcQEZzAGh]/.test(pattern)) return "Unicode/escape classes like \\p, \\u, \\x, \\Q are not allowed.";
  if (/\[\^?\]/.test(pattern)) return "Empty character classes are not allowed.";
  if (/\{,/.test(pattern)) return "Quantifiers like {,n} are not allowed -- use {0,n}.";
  if (/\((?:[^()\\]|\\.)*[*+}](?:[^()\\]|\\.)*\)\s*[*+{]/.test(pattern)) {
    return "Nested repetition like (a+)+ is not allowed -- it can freeze the phone on some SMS.";
  }
  try {
    new RegExp(pattern, "i");
  } catch (err) {
    return `The pattern is not valid: ${(err as Error).message}`;
  }
  return null;
}

export function captureGroupCount(pattern: string): number {
  return new RegExp(`${pattern}|`).exec("")!.length - 1;
}

export function validateRule(rule: SmsFormatRule): string | null {
  const patternError = validatePattern(rule.pattern);
  if (patternError) return patternError;
  const groups = captureGroupCount(rule.pattern);
  const inRange = (g: number | null) => g == null || (Number.isInteger(g) && g >= 1 && g <= groups);
  if (!Number.isInteger(rule.amountGroup) || !Number.isInteger(rule.senderGroup)) return "Choose which capture group holds the amount and the sender number.";
  if (!inRange(rule.amountGroup) || !inRange(rule.senderGroup) || !inRange(rule.referenceGroup) || !inRange(rule.recipientGroup)) {
    return `A field points at a capture group the pattern doesn't have (it has ${groups}).`;
  }
  const used = [rule.amountGroup, rule.senderGroup, rule.referenceGroup, rule.recipientGroup].filter((g) => g != null);
  if (new Set(used).size !== used.length) return "Two fields can't read the same capture group.";
  if (!Array.isArray(rule.keywords) || rule.keywords.filter((k) => String(k).trim()).length === 0) {
    return "Add at least one keyword (words every SMS of this format contains, e.g. \"Ayaad ka Heshay\") so other SMS from the same sender can't be mistaken for a payment.";
  }
  if (!Array.isArray(rule.senders) || rule.senders.filter((s) => String(s).trim()).length === 0) {
    return "Add at least one SMS sender ID for this provider.";
  }
  return null;
}

export function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Reads one SMS with one rule. Sender checks are the caller's job. */
export function applyRule(rule: SmsFormatRule, rawBody: string): ApplyResult {
  const body = normalizeSms(rawBody);
  const missing = hasKeywords(body, rule.keywords);
  if (missing) return { ok: false, reason: `The SMS doesn't contain the keyword "${missing}".` };
  let match: RegExpExecArray | null;
  try {
    match = new RegExp(rule.pattern, "i").exec(body);
  } catch (err) {
    return { ok: false, reason: `The pattern is not valid: ${(err as Error).message}` };
  }
  if (!match) return { ok: false, reason: "The pattern doesn't match this SMS." };
  const amount = parseAmount(match[rule.amountGroup]);
  if (amount == null) return { ok: false, reason: "No valid amount was read from the SMS." };
  const senderPhone = match[rule.senderGroup];
  if (!senderPhone || !/^\d{6,15}$/.test(senderPhone)) return { ok: false, reason: "No valid sender number was read from the SMS." };
  const pick = (g: number | null) => (g != null && match![g] ? match![g] : null);
  return {
    ok: true,
    extracted: { amount, senderPhone, reference: pick(rule.referenceGroup), recipientPhone: pick(rule.recipientGroup) },
  };
}

// ---------------- Learning a format from one pasted SMS ----------------

type Candidate = { value: string; start: number; end: number };
type AmountCandidate = Candidate & { prefixDollar: boolean; suffix: string | null };
type PhoneCandidate = Candidate & { anchor: { kind: "paren" } | { kind: "label"; label: string } | { kind: "none" } };
type ReferenceCandidate = Candidate & { label: string | null };

export type Candidates = { amounts: AmountCandidate[]; phones: PhoneCandidate[]; references: ReferenceCandidate[] };

const AMOUNT_CAPTURE = "([\\d,]+(?:\\.\\d+)?)";
const PHONE_CAPTURE = "(\\d{6,15})";
const REFERENCE_CAPTURE = "([A-Za-z0-9][A-Za-z0-9.\\-]*[A-Za-z0-9])";
const GAP = "[\\s\\S]*?";
const BRAND_WORDS = ["eDahab", "EVCPlus", "EVC Plus", "Somnet", "Hormuud", "Somtel", "Amtel", "E-Voucher", "Jeeb", "Waafi"];

function escapeLiteral(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&"))
    .join("\\s+");
}

function labelBefore(text: string, index: number): string | null {
  const m = /([A-Za-z][A-Za-z\-]{1,24})\s*:\s*$/.exec(text.slice(Math.max(0, index - 40), index));
  return m ? m[1] : null;
}

export function detectCandidates(raw: string): Candidates {
  const sms = normalizeSms(raw);
  const amounts: AmountCandidate[] = [];
  const taken = (start: number, end: number, list: Candidate[]) => list.some((c) => start < c.end && end > c.start);

  for (const m of sms.matchAll(/\$\s*([\d,]*\d(?:\.\d+)?)/g)) {
    const start = m.index! + m[0].length - m[1].length;
    amounts.push({ value: m[1], start, end: start + m[1].length, prefixDollar: true, suffix: null });
  }
  for (const m of sms.matchAll(/(?<![\w.$])([\d,]*\d(?:\.\d+)?)\s*(\$|USD\b|Dollars?\b)/gi)) {
    const start = m.index!;
    if (taken(start, start + m[1].length, amounts)) continue;
    amounts.push({ value: m[1], start, end: start + m[1].length, prefixDollar: false, suffix: m[2] });
  }
  amounts.sort((a, b) => a.start - b.start);

  const phones: PhoneCandidate[] = [];
  for (const m of sms.matchAll(/(?<![\w.,\-\/])(\d{6,15})(?![\w\-\/:]|\.\d)/g)) {
    const start = m.index!;
    const end = start + m[1].length;
    if (taken(start, end, amounts)) continue;
    const before = sms.slice(0, start);
    const after = sms.slice(end);
    let anchor: PhoneCandidate["anchor"] = { kind: "none" };
    if (/\(\s*$/.test(before) && /^\s*\)/.test(after)) anchor = { kind: "paren" };
    else {
      const label = labelBefore(sms, start);
      if (label) anchor = { kind: "label", label };
    }
    phones.push({ value: m[1], start, end, anchor });
  }

  const references: ReferenceCandidate[] = [];
  for (const m of sms.matchAll(/(?<![\w.\-\/])([A-Za-z0-9][A-Za-z0-9.\-]*[A-Za-z0-9])/g)) {
    const value = m[1];
    const start = m.index!;
    const end = start + value.length;
    if (value.length < 6 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) continue;
    if (sms.slice(end, end + 3) === "://" || sms.slice(Math.max(0, start - 1), start) === "/") continue;
    if (taken(start, end, [...amounts, ...phones])) continue;
    references.push({ value, start, end, label: labelBefore(sms, start) });
  }
  return { amounts, phones, references };
}

export type FieldChoice = {
  amountIndex: number;
  senderIndex: number;
  referenceIndex: number; // -1 = none
  recipientIndex: number; // -1 = none
};

export function defaultChoice(c: Candidates): FieldChoice {
  return {
    amountIndex: c.amounts.length > 0 ? 0 : -1,
    senderIndex: c.phones.length > 0 ? 0 : -1,
    referenceIndex: c.references.length > 0 ? 0 : -1,
    recipientIndex: c.phones.length > 1 ? 1 : -1,
  };
}

function referenceShape(value: string): string {
  return value.replace(/[A-Za-z]+|\d+|[^A-Za-z\d]+/g, (run) =>
    /^[A-Za-z]+$/.test(run) ? "[A-Za-z]+" : /^\d+$/.test(run) ? "\\d+" : run.replace(/[.\-]/g, "\\$&")
  );
}

/** Words right after the amount (e.g. "Ayaad ka Heshay") plus any brand tag. */
export function suggestKeywords(raw: string, amount: AmountCandidate | undefined): string[] {
  const sms = normalizeSms(raw);
  const keywords: string[] = [];
  if (amount) {
    const afterStart = amount.prefixDollar ? amount.end : amount.end + (sms.slice(amount.end).match(/^\s*(\$|USD\b|Dollars?\b)/i)?.[0].length ?? 0);
    const words: string[] = [];
    for (const token of sms.slice(afterStart).trim().split(/\s+/)) {
      if (!/^[A-Za-z]+$/.test(token) || words.length >= 3) break;
      words.push(token);
    }
    // The word right before the amount often tells formats apart too:
    // Hormuud's "waxaad $1 ka heshay" vs Somnet's "$0.1 ayaad ka Heshay".
    const before = sms.slice(0, amount.prefixDollar ? sms.lastIndexOf("$", amount.start) : amount.start).trim().split(/\s+/);
    const lead: string[] = [];
    for (let i = before.length - 1; i >= 0 && lead.length < (words.length < 2 ? 2 : 1); i--) {
      if (!/^[A-Za-z]+$/.test(before[i])) break;
      lead.unshift(before[i]);
    }
    if (lead.length > 0) keywords.push(lead.join(" "));
    if (words.length > 0) keywords.push(words.join(" "));
  }
  for (const brand of BRAND_WORDS) {
    const re = new RegExp(`(?<![A-Za-z])${escapeLiteral(brand)}(?![A-Za-z])`, "i");
    const m = re.exec(sms);
    if (m && !keywords.some((k) => collapse(k).includes(collapse(brand)))) keywords.push(m[0]);
  }
  return keywords;
}

type Piece = { start: number; source: string; field: "amount" | "sender" | "reference" | "recipient"; optional: boolean };

/** Builds a rule that reads [choice]'s values out of SMS shaped like [raw]. */
export function generateRule(raw: string, c: Candidates, choice: FieldChoice): { rule: Omit<SmsFormatRule, "keywords" | "senders">; error?: string } {
  const empty = { pattern: "", amountGroup: 0, senderGroup: 0, referenceGroup: null, recipientGroup: null };
  const amount = c.amounts[choice.amountIndex];
  const sender = c.phones[choice.senderIndex];
  if (!amount) return { rule: empty, error: "No amount was found in this SMS (expected something like \"$0.50\" or \"0.50 Dollar\")." };
  if (!sender) return { rule: empty, error: "No sender phone number was found in this SMS." };
  const reference = choice.referenceIndex >= 0 ? c.references[choice.referenceIndex] : undefined;
  const recipient = choice.recipientIndex >= 0 ? c.phones[choice.recipientIndex] : undefined;
  if (recipient && recipient === sender) return { rule: empty, error: "The sender and recipient can't be the same number." };

  const phonePiece = (p: PhoneCandidate) =>
    p.anchor.kind === "paren"
      ? `\\(\\s*${PHONE_CAPTURE}\\s*\\)`
      : p.anchor.kind === "label"
        ? `${escapeLiteral(p.anchor.label)}\\s*:\\s*${PHONE_CAPTURE}`
        : `\\b${PHONE_CAPTURE}\\b`;

  const pieces: Piece[] = [
    {
      start: amount.start,
      field: "amount",
      optional: false,
      source: amount.prefixDollar ? `\\$\\s*${AMOUNT_CAPTURE}` : `${AMOUNT_CAPTURE}\\s*${amount.suffix === "$" ? "\\$" : escapeLiteral(amount.suffix!)}`,
    },
    { start: sender.start, field: "sender", optional: false, source: phonePiece(sender) },
  ];
  if (reference) {
    pieces.push({
      start: reference.start,
      field: "reference",
      optional: true,
      source: reference.label ? `${escapeLiteral(reference.label)}\\s*:\\s*${REFERENCE_CAPTURE}` : `\\b(${referenceShape(reference.value)})`,
    });
  }
  if (recipient) pieces.push({ start: recipient.start, field: "recipient", optional: true, source: phonePiece(recipient) });
  pieces.sort((a, b) => a.start - b.start);

  let pattern = "";
  const groups: Record<string, number> = {};
  pieces.forEach((piece, i) => {
    groups[piece.field] = i + 1;
    if (i === 0) pattern += piece.optional ? `(?:${piece.source}${GAP})?` : piece.source;
    else pattern += piece.optional ? `(?:${GAP}${piece.source})?` : `${GAP}${piece.source}`;
  });
  return {
    rule: {
      pattern,
      amountGroup: groups.amount,
      senderGroup: groups.sender,
      referenceGroup: groups.reference ?? null,
      recipientGroup: groups.recipient ?? null,
    },
  };
}

// ---------------- Known SMS a new format must never misread ----------------

/**
 * Real samples (from the Agent App's parser tests). A provider's new format
 * may only read its own provider's payments: reading another provider's
 * payment, or ANY outgoing-transfer confirmation, blocks activation.
 */
export const KNOWN_SMS_SAMPLES: { label: string; parsedProvider: string | null; senders: string[]; body: string }[] = [
  { label: "Hormuud EVC Plus payment", parsedProvider: "Hormuud", senders: ["192", "EVCPLUS"], body: "[-EVCPLUS-] waxaad $0.1 ka heshay 0610346060, Tar: 24/07/26" },
  {
    label: "Somnet EVC Plus payment",
    parsedProvider: "Somnet",
    senders: ["192"],
    body: "[-EVCPlus-] $0.1 ayaad ka Heshay AARAN DATA SERVICE (252685115555),27/07/26 04:49:01 via Somnet Telecom, Haraagaagu waa $4.95.",
  },
  {
    label: "eDahab payment",
    parsedProvider: "Somtel",
    senders: ["eDahab"],
    body: "0.22 Dollar Ayaad Ka Heshay Yaasiin Maxamed Aadan.Code-ka:NA.Lambarka :620346060  Aqanoosiga : PP260718.0005.F75709 Haraagaaga Cusubi Waa: 2.61 Dollar..Tariikh:18-07-2026[-eDahab-Service-]",
  },
  {
    label: "eDahab outgoing transfer",
    parsedProvider: null,
    senders: ["eDahab"],
    body: "1.98 Dollar ayad u warejisay Yaasiin Maxamed Aadan. No: 620346060.Tixrac: PP260814.1137.E48452 Haraaga: 0.07 Dollar Kharashyada Adeegga:0 Dollar Tariikh:14-08-2026[-eDahab-Service-]",
  },
  {
    label: "Hormuud E-Voucher outgoing transfer",
    parsedProvider: null,
    senders: ["740"],
    body: "[-E-Voucher-] $1 ayaad uwareejisay YAASIIN MAXAMED AADAN(617080008), Haraagaagu waa $3.32.\nLa soo deg App-ka WAAFI http://onelink.to/waafi",
  },
  { label: "Hormuud E-Voucher top-up sent", parsedProvider: null, senders: ["740"], body: "[-E-Voucher-] You have transferred $0.1 to 252619991299. Your balance is $0.27." },
];

export type ActiveFormatRow = SmsFormatRule & { id: string; provider: string; version: number; sampleSms: string };

function sendersOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => x.trim().toLowerCase() === y.trim().toLowerCase()));
}

/**
 * What a new rule for [provider] would wrongly read, or which other
 * provider's active rule would also read this provider's sample.
 */
export function findConflicts(provider: SmsFormatProvider, rule: SmsFormatRule, sample: string, otherActive: ActiveFormatRow[]): string[] {
  const conflicts: string[] = [];
  for (const known of KNOWN_SMS_SAMPLES) {
    if (known.parsedProvider === provider.parsedProvider) continue;
    if (!sendersOverlap(rule.senders, known.senders)) continue;
    if (applyRule(rule, known.body).ok) {
      conflicts.push(
        known.parsedProvider
          ? `This format also reads a ${known.label} SMS. Add a keyword that only ${provider.label} SMS contain.`
          : `This format also reads an ${known.label} SMS (money sent, not received). Add a keyword that only incoming payments contain.`
      );
    }
  }
  for (const other of otherActive) {
    const otherProvider = providerByKey(other.provider);
    if (other.provider === provider.key || !otherProvider || otherProvider.parsedProvider === provider.parsedProvider) continue;
    if (!sendersOverlap(rule.senders, other.senders)) continue;
    if (applyRule(rule, other.sampleSms).ok) {
      conflicts.push(`This format also reads ${otherProvider.label}'s active SMS format. Add a keyword that only ${provider.label} SMS contain.`);
    }
    if (applyRule(other, sample).ok) {
      conflicts.push(`${otherProvider.label}'s active SMS format would also read this SMS. Make the two formats' keywords distinct.`);
    }
  }
  return conflicts;
}

// ---------------- Active rules, cached for the ingest fallback ----------------

let activeCache: { at: number; rows: ActiveFormatRow[] } | null = null;
const CACHE_MS = 30_000;

export function clearSmsFormatCache(): void {
  activeCache = null;
}

export async function loadActiveFormats(): Promise<ActiveFormatRow[]> {
  if (activeCache && Date.now() - activeCache.at < CACHE_MS) return activeCache.rows;
  const rows = await query<any>(
    `SELECT id, provider, version, sample_sms, pattern, amount_group, sender_group, reference_group, recipient_group, keywords, senders
       FROM sms_format_rules WHERE status='active' ORDER BY provider`
  );
  const mapped: ActiveFormatRow[] = rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    version: r.version,
    sampleSms: r.sample_sms,
    pattern: r.pattern,
    amountGroup: r.amount_group,
    senderGroup: r.sender_group,
    referenceGroup: r.reference_group,
    recipientGroup: r.recipient_group,
    keywords: r.keywords ?? [],
    senders: r.senders ?? [],
  }));
  activeCache = { at: Date.now(), rows: mapped };
  return mapped;
}

export type ParsedByFormat = Extracted & { parsedProvider: string; provider: string; version: number };

/** Reads an SMS with whichever active format belongs to its sender, if any. */
export function parseWithFormats(formats: ActiveFormatRow[], sender: string, body: string): ParsedByFormat | null {
  const from = sender.trim().toLowerCase();
  for (const f of formats) {
    const provider = providerByKey(f.provider);
    if (!provider) continue;
    if (!f.senders.some((s) => s.trim().toLowerCase() === from)) continue;
    const result = applyRule(f, body);
    if (result.ok) return { ...result.extracted, parsedProvider: provider.parsedProvider, provider: f.provider, version: f.version };
  }
  return null;
}
