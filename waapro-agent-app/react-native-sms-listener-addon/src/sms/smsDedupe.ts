import { RawSms } from "../types/sms";

/**
 * A deterministic id for a given SMS, used to prevent double-processing —
 * required because Android can redeliver SMS_RECEIVED broadcasts (e.g. app
 * killed and restarted mid-processing), and because the same SMS shouldn't
 * be uploaded twice just because the listener re-subscribed.
 *
 * Built from sender + body + a minute-granularity timestamp bucket (not the
 * exact millisecond) so that minor timestamp jitter from the OS delivering
 * the same logical message twice still collapses to the same key.
 */
export function smsDedupeKey(raw: RawSms): string {
  const minuteBucket = Math.floor(raw.timestampMs / 60000);
  const basis = `${raw.sender}|${raw.body}|${minuteBucket}`;
  return simpleHash(basis);
}

/** Small, dependency-free string hash (FNV-1a) — good enough for a local dedupe key, not for security. */
function simpleHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
