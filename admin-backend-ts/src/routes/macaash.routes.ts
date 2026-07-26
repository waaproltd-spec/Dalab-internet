import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";

export const macaashRouter = Router();

// Static catalog for now — a REWARDS table would replace this if the
// catalog needs to change without a deploy, a reasonable next step but not
// built here (matches the same design decision made in the SQLite backend).
const REWARDS = [
  { id: "rw-1", title: "300 MB Data Voucher", cost: 300 },
  { id: "rw-2", title: "Free SMS Pack (100 SMS)", cost: 300 },
  { id: "rw-3", title: "$1 Airtime Credit", cost: 800 },
  { id: "rw-4", title: "1 GB Data Voucher", cost: 1200 },
];

macaashRouter.get("/macaash/balance", requireAuth("customer"), async (req, res) => {
  const customer = await queryOne(`SELECT macaash_points FROM customers WHERE id=$1`, [req.auth!.sub]);
  sendJson(res, 200, { balance: customer?.macaash_points ?? 0 });
});

macaashRouter.get("/macaash/rewards", requireAuth("customer"), async (_req, res) => {
  sendJson(res, 200, REWARDS);
});

macaashRouter.post("/macaash/redeem", requireAuth("customer"), async (req, res) => {
  const reward = REWARDS.find((r) => r.id === req.body.rewardId);
  if (!reward) return sendJson(res, 404, { error: "Unknown reward" });

  const customer = await queryOne(`SELECT * FROM customers WHERE id=$1`, [req.auth!.sub]);
  if (!customer || customer.macaash_points < reward.cost) return sendJson(res, 409, { error: "Not enough points" });

  await query(`UPDATE customers SET macaash_points = macaash_points - $1 WHERE id=$2`, [reward.cost, req.auth!.sub]);
  await query(
    `INSERT INTO macaash_transactions (id, customer_id, points, reason) VALUES ($1,$2,$3,$4)`,
    [randomUUID(), req.auth!.sub, -reward.cost, `Redeemed ${reward.title}`]
  );
  sendJson(res, 200, { redeemed: reward.title, remainingBalance: customer.macaash_points - reward.cost });
});

macaashRouter.get("/macaash/history", requireAuth("customer"), async (req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM macaash_transactions WHERE customer_id=$1 ORDER BY created_at DESC`, [req.auth!.sub]));
});
