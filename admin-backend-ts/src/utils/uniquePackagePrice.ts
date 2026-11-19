import { query } from "../db/pool.js";

/**
 * Every active service of a company has its own price: Rukumo (and an agent
 * reading a payment SMS) can only tell which service a customer paid for by
 * its amount. Returns [desired] when no other active service of the company
 * costs that, otherwise the next free price one cent at a time
 * ($5.00 taken -> $5.01 -> $5.02 ...).
 */
export async function uniquePackagePrice(companyId: string, desired: number, excludePackageId: string | null): Promise<number> {
  const rows = await query<{ price: string }>(
    `SELECT price FROM packages WHERE company_id=$1 AND active=true AND ($2::uuid IS NULL OR id<>$2)`,
    [companyId, excludePackageId]
  );
  const taken = new Set(rows.map((r) => Math.round(Number(r.price) * 100)));
  let cents = Math.round(Number(desired) * 100);
  while (taken.has(cents)) cents++;
  return cents / 100;
}
