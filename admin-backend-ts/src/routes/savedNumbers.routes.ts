import { randomUUID } from "node:crypto";
import { Router } from "express";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { validateMobileNumber, normalizeMobileDigits, PHONE_COMPANIES } from "../lib/phoneValidation.js";

// "My Numbers" -- see 107_customer_saved_numbers.sql for the schema this is
// built on. A general-purpose address book of a customer's own phone
// numbers, each tagged with a carrier/wallet (provider_key, one of
// PHONE_COMPANIES' keys), reused when placing an Internet Store order
// instead of retyping the destination number every time. Scoped to
// Internet purchases only -- unrelated to, and doesn't touch, the existing
// evc_plus_number/edahab_number wallet-numbers feature Money Exchange uses
// (see customers.routes.ts PUT /customer/wallet-numbers), which keeps its
// own separate 2-hour edit lock.
export const savedNumbersRouter = Router();

const SAVED_NUMBER_COLUMNS = "id, phone, provider_key, label, is_default, created_at, updated_at";

function validProviderKey(key: unknown): key is string {
  return typeof key === "string" && PHONE_COMPANIES.some((c) => c.key === key);
}

savedNumbersRouter.get("/customer/saved-numbers", requireAuth("customer"), async (req, res) => {
  const rows = await query(
    `SELECT ${SAVED_NUMBER_COLUMNS} FROM customer_saved_numbers WHERE customer_id=$1 ORDER BY is_default DESC, created_at ASC`,
    [req.auth!.sub]
  );
  sendJson(res, 200, rows);
});

savedNumbersRouter.post("/customer/saved-numbers", requireAuth("customer"), async (req, res) => {
  const providerKey = req.body.providerKey;
  if (!validProviderKey(providerKey)) return sendJson(res, 400, { error: "providerKey must be a known carrier" });

  const phoneCheck = validateMobileNumber(req.body.phone, providerKey);
  if (!phoneCheck.valid) return sendJson(res, 400, { error: phoneCheck.error });
  const phone = `252${normalizeMobileDigits(req.body.phone)}`;

  const label = typeof req.body.label === "string" && req.body.label.trim() ? req.body.label.trim() : null;
  const isDefault = req.body.isDefault === true;
  const id = randomUUID();

  await withTransaction(async (client) => {
    // A customer's very first saved number becomes their default
    // automatically, same as any UI would pre-select the only option --
    // checked inside the transaction so a concurrent first-save race can't
    // leave a customer with zero default numbers.
    const existingCount = await client.query(`SELECT COUNT(*) AS n FROM customer_saved_numbers WHERE customer_id=$1`, [
      req.auth!.sub,
    ]);
    const makeDefault = isDefault || Number(existingCount.rows[0]?.n ?? 0) === 0;
    if (makeDefault) {
      await client.query(`UPDATE customer_saved_numbers SET is_default=false WHERE customer_id=$1`, [req.auth!.sub]);
    }
    await client.query(
      `INSERT INTO customer_saved_numbers (id, customer_id, phone, provider_key, label, is_default) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.auth!.sub, phone, providerKey, label, makeDefault]
    );
  });

  sendJson(res, 201, await queryOne(`SELECT ${SAVED_NUMBER_COLUMNS} FROM customer_saved_numbers WHERE id=$1`, [id]));
});

savedNumbersRouter.put("/customer/saved-numbers/:id", requireAuth("customer"), async (req, res) => {
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM customer_saved_numbers WHERE id=$1 AND customer_id=$2`,
    [req.params.id, req.auth!.sub]
  );
  if (!existing) return sendJson(res, 404, { error: "Number not found" });

  const providerKey = req.body.providerKey;
  if (!validProviderKey(providerKey)) return sendJson(res, 400, { error: "providerKey must be a known carrier" });

  const phoneCheck = validateMobileNumber(req.body.phone, providerKey);
  if (!phoneCheck.valid) return sendJson(res, 400, { error: phoneCheck.error });
  const phone = `252${normalizeMobileDigits(req.body.phone)}`;

  const label = typeof req.body.label === "string" && req.body.label.trim() ? req.body.label.trim() : null;

  await query(
    `UPDATE customer_saved_numbers SET phone=$1, provider_key=$2, label=$3, updated_at=now() WHERE id=$4`,
    [phone, providerKey, label, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT ${SAVED_NUMBER_COLUMNS} FROM customer_saved_numbers WHERE id=$1`, [req.params.id]));
});

// A dedicated action rather than folding into the general PUT above -- the
// "exactly one default" invariant (see the migration's partial unique
// index) needs the same unset-then-set transaction every time, regardless
// of what else about the number is or isn't being edited in the same
// request.
savedNumbersRouter.put("/customer/saved-numbers/:id/default", requireAuth("customer"), async (req, res) => {
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM customer_saved_numbers WHERE id=$1 AND customer_id=$2`,
    [req.params.id, req.auth!.sub]
  );
  if (!existing) return sendJson(res, 404, { error: "Number not found" });

  await withTransaction(async (client) => {
    await client.query(`UPDATE customer_saved_numbers SET is_default=false WHERE customer_id=$1`, [req.auth!.sub]);
    await client.query(`UPDATE customer_saved_numbers SET is_default=true, updated_at=now() WHERE id=$1`, [req.params.id]);
  });
  sendJson(res, 200, await queryOne(`SELECT ${SAVED_NUMBER_COLUMNS} FROM customer_saved_numbers WHERE id=$1`, [req.params.id]));
});

savedNumbersRouter.delete("/customer/saved-numbers/:id", requireAuth("customer"), async (req, res) => {
  const existing = await queryOne<{ id: string; is_default: boolean }>(
    `SELECT id, is_default FROM customer_saved_numbers WHERE id=$1 AND customer_id=$2`,
    [req.params.id, req.auth!.sub]
  );
  if (!existing) return sendJson(res, 404, { error: "Number not found" });

  await query(`DELETE FROM customer_saved_numbers WHERE id=$1`, [req.params.id]);

  // Deleting the default leaves nobody selected -- promote the
  // next-oldest remaining number (if any) so a customer with other saved
  // numbers is never left with none marked default.
  if (existing.is_default) {
    const next = await queryOne<{ id: string }>(
      `SELECT id FROM customer_saved_numbers WHERE customer_id=$1 ORDER BY created_at ASC LIMIT 1`,
      [req.auth!.sub]
    );
    if (next) await query(`UPDATE customer_saved_numbers SET is_default=true WHERE id=$1`, [next.id]);
  }

  sendJson(res, 200, { deleted: true });
});
