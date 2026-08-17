import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { hashPassword, generateOtp } from "../auth/crypto.js";
import { sendJson } from "../utils/camelCase.js";
import { adjustResellerWallet } from "../utils/resellerWallet.js";

export const resellersRouter = Router();

const RESELLER_LIST_SELECT = `
  SELECT r.id, r.reseller_login_id, r.name, r.status, r.phone, r.notes, r.last_login_at, r.created_at,
         COALESCE(w.balance, 0) AS wallet_balance
  FROM resellers r
  LEFT JOIN reseller_wallets w ON w.reseller_id = r.id
`;

async function generateUniqueResellerLoginId(): Promise<string> {
  // Small collision space (6 digits) but this is an infrequent, admin-only
  // action — a couple of retries on a 23505-equivalent pre-check is enough,
  // matching this codebase's general tolerance for a cheap retry over a
  // more elaborate ID scheme (see orderRef()/exchangeOrderRef()).
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = "RSL" + generateOtp(6);
    if (!(await queryOne(`SELECT id FROM resellers WHERE reseller_login_id=$1`, [candidate]))) {
      return candidate;
    }
  }
  throw new Error("Could not generate a unique reseller ID — try again");
}

// ---------------- Reseller-facing (requireAuth("reseller")) ----------------

resellersRouter.get("/reseller/me", requireAuth("reseller"), async (req, res) => {
  const reseller = await queryOne(
    `SELECT r.id, r.reseller_login_id, r.name, r.status, COALESCE(w.balance, 0) AS wallet_balance
     FROM resellers r LEFT JOIN reseller_wallets w ON w.reseller_id = r.id
     WHERE r.id=$1`,
    [req.auth!.sub]
  );
  if (!reseller) return sendJson(res, 404, { error: "Reseller not found" });
  sendJson(res, 200, reseller);
});

// ---------------- Admin-facing (requirePermission("resellers.manage"), PIN reset is super_admin-only) ----------------

resellersRouter.get("/admin/resellers", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`${RESELLER_LIST_SELECT} ORDER BY r.created_at DESC`));
});

resellersRouter.get("/admin/resellers/:id", requireStaff(), async (req, res) => {
  const reseller = await queryOne(`${RESELLER_LIST_SELECT} WHERE r.id=$1`, [req.params.id]);
  if (!reseller) return sendJson(res, 404, { error: "Reseller not found" });
  sendJson(res, 200, reseller);
});

// Creates the reseller, its wallet row, and a fresh 8-digit PIN in one go.
// The plaintext PIN is returned exactly once here — same one-time-reveal UX
// as resetCustomerPassword — and never retrievable again after this response.
resellersRouter.post("/admin/resellers", requirePermission("resellers.manage"), async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  const phone = req.body.phone ? String(req.body.phone).trim() : null;
  const notes = req.body.notes ? String(req.body.notes).trim() : null;
  if (!name) return sendJson(res, 400, { error: "name is required" });

  const resellerLoginId = await generateUniqueResellerLoginId();
  const pin = generateOtp(8);
  const id = randomUUID();

  await query(
    `INSERT INTO resellers (id, reseller_login_id, name, pin_hash, phone, notes, created_by_admin_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, resellerLoginId, name, await hashPassword(pin), phone, notes, req.auth!.sub]
  );
  await query(`INSERT INTO reseller_wallets (reseller_id) VALUES ($1)`, [id]);

  sendJson(res, 201, { id, resellerLoginId, name, status: "active", tempPin: pin });
});

resellersRouter.put("/admin/resellers/:id/status", requirePermission("resellers.manage"), async (req, res) => {
  const reseller = await queryOne(`SELECT * FROM resellers WHERE id=$1`, [req.params.id]);
  if (!reseller) return sendJson(res, 404, { error: "Reseller not found" });
  const next = reseller.status === "active" ? "suspended" : "active";
  await query(`UPDATE resellers SET status=$1, updated_at=now() WHERE id=$2`, [next, req.params.id]);
  sendJson(res, 200, { id: reseller.id, status: next });
});

// Hard-restricted to super_admin regardless of the resellers.manage grant —
// same carve-out already established for customer PINs and the exchange
// payout-wallet PIN (see auth/permissions.ts's requirePermission doc and the
// equivalent checks in customers.routes.ts / exchange.routes.ts).
resellersRouter.put("/admin/resellers/:id/pin", requireAuth("super_admin"), async (req, res) => {
  const reseller = await queryOne(`SELECT id FROM resellers WHERE id=$1`, [req.params.id]);
  if (!reseller) return sendJson(res, 404, { error: "Reseller not found" });
  const pin = generateOtp(8);
  await query(`UPDATE resellers SET pin_hash=$1, updated_at=now() WHERE id=$2`, [await hashPassword(pin), req.params.id]);
  sendJson(res, 200, { id: reseller.id, tempPin: pin });
});

// Manual balance correction/top-up — the only wallet-adjustment path in
// Stage 1 (order/exchange/deposit/withdrawal debits and SMS-verified
// deposit credits land in later stages, all through the same
// adjustResellerWallet helper).
resellersRouter.put("/admin/resellers/:id/wallet/adjust", requirePermission("resellers.manage"), async (req, res) => {
  const reseller = await queryOne(`SELECT id FROM resellers WHERE id=$1`, [req.params.id]);
  if (!reseller) return sendJson(res, 404, { error: "Reseller not found" });
  const changeAmount = Number(req.body.changeAmount);
  if (!Number.isFinite(changeAmount) || changeAmount === 0) {
    return sendJson(res, 400, { error: "changeAmount must be a non-zero number" });
  }
  try {
    const result = await adjustResellerWallet({
      resellerId: req.params.id,
      changeAmount,
      referenceType: "admin_adjustment",
      referenceId: null,
      source: "admin_manual",
      changedByAdminId: req.auth!.sub,
    });
    sendJson(res, 200, { id: req.params.id, ...result });
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
  }
});
