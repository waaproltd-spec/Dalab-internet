import { queryOne } from "../db/pool.js";

/**
 * Finds an existing customer by phone, matching on the same bare-last-9-digits
 * form offlineAutoOrder.ts's matching query already uses for
 * offline_sender_number (RIGHT(regexp_replace(...,'\D','','g'),9)) — NOT the
 * exact stored string. validateMobileNumber() (lib/phoneValidation.ts)
 * already accepts "+252619991299", "252619991299", and "619991299" as the
 * same valid number, but every customer-identity lookup used to compare
 * against the raw, merely-trimmed string customers.phone was inserted with.
 * Since customers.phone is UNIQUE on that raw string (001_init.sql), the
 * same real phone submitted in two different formats on two different
 * occasions (a different client, a different flow: Customer App login vs.
 * guest checkout vs. an agent's walk-in sale) silently created two separate
 * `customers` rows instead of being recognized as the same account — the
 * confirmed root cause of Offline Auto-Order's "N Offline Profiles ...
 * ambiguous, refusing to auto-order" failure (two rows' offline_sender_number
 * both normalize to the same 9 digits), and of a real customer's order
 * history/Macaash points silently splitting across two identities.
 *
 * Deliberately does NOT touch any already-stored customers.phone value or
 * merge/dedupe any existing duplicate rows — those need a separate, reviewed
 * cleanup. This only stops NEW duplicates from being created, by finding an
 * existing account regardless of which format it (or this request) used.
 * Every INSERT INTO customers call site is unchanged — a brand-new row still
 * stores whatever raw string the client sent, same as before.
 *
 * If more than one existing row already matches (an account already split by
 * this bug before the fix), the oldest one is returned deterministically —
 * never an arbitrary one dependent on query plan/insertion order.
 */
export async function findCustomerByPhone(phone: string): Promise<any | null> {
  const digits = String(phone ?? "").replace(/\D/g, "").slice(-9);
  if (digits.length < 6) return null;
  return queryOne(
    `SELECT * FROM customers WHERE RIGHT(regexp_replace(phone, '\\D', '', 'g'), 9) = $1 ORDER BY created_at ASC LIMIT 1`,
    [digits]
  );
}
