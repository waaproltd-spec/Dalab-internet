import { randomUUID } from "node:crypto";
import { queryOne } from "../db/pool.js";
import { normalizeMobileDigits } from "./phoneValidation.js";

/**
 * One customer per phone number, whatever spelling a client sends.
 *
 * The Customer App sends "252" + 9 digits, the Agent App and some admin
 * paths send the bare 9 digits, older builds sent "+252...". Matching
 * customers.phone byte-for-byte made a second account whenever a number
 * arrived in a different spelling (8 such pairs were found in production,
 * one created from an agent order). Every lookup that may create a customer
 * goes through here instead: it finds the row in any spelling, and a new
 * row is always stored as "252" + 9 digits. Migration 125's unique index on
 * the 9-digit form is the database-level backstop.
 *
 * A value that isn't a 9-digit local number (after stripping a leading
 * 252) is looked up and stored exactly as given, as before.
 */
export function canonicalCustomerPhone(raw: unknown): string {
  const local = normalizeMobileDigits(String(raw ?? ""));
  return /^\d{9}$/.test(local) ? `252${local}` : String(raw ?? "").trim();
}

export async function findCustomerByPhone<T = any>(raw: unknown, columns = "*"): Promise<T | null> {
  const local = normalizeMobileDigits(String(raw ?? ""));
  if (!/^\d{9}$/.test(local)) {
    return queryOne<T>(`SELECT ${columns} FROM customers WHERE phone=$1`, [String(raw ?? "").trim()]);
  }
  // The "252..." row first (the spelling the Customer App signs in with),
  // then the oldest, so every caller agrees on the same row.
  return queryOne<T>(
    `SELECT ${columns} FROM customers WHERE phone IN ($1, $2, $3) ORDER BY (phone = $2) DESC, created_at ASC LIMIT 1`,
    [local, `252${local}`, `+252${local}`]
  );
}

/**
 * The customer for this number, created (phone + the given columns) only
 * when no spelling of it exists. Race-safe: a concurrent create of the same
 * number makes the INSERT a no-op and the existing row is returned.
 * `created` tells the caller which happened.
 */
export async function findOrCreateCustomerByPhone<T = any>(
  raw: unknown,
  values: Record<string, unknown> = {},
  columns = "*"
): Promise<{ customer: T; created: boolean }> {
  const existing = await findCustomerByPhone<T>(raw, columns);
  if (existing) return { customer: existing, created: false };
  const names = ["id", "phone", ...Object.keys(values)];
  const params = [null, canonicalCustomerPhone(raw), ...Object.values(values)];
  const placeholders = names.map((_, i) => `$${i + 1}`).join(",");
  // Up to 3 tries: a skipped insert is this number created a moment ago by
  // another request, or (rarely) a clash on the random friend_code default.
  for (let i = 0; i < 3; i++) {
    params[0] = randomUUID();
    const inserted = await queryOne<T>(
      `INSERT INTO customers (${names.join(",")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING RETURNING ${columns}`,
      params
    );
    if (inserted) return { customer: inserted, created: true };
    const now = await findCustomerByPhone<T>(raw, columns);
    if (now) return { customer: now, created: false };
  }
  throw new Error("Could not create the customer account");
}
