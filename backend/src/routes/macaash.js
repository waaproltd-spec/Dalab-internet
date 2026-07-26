import { randomUUID } from "node:crypto";
import { requireAuth } from "../auth/middleware.js";

// Static reward catalog for now — mirrors what the customer app prototype
// showed; a REWARDS table would replace this if the catalog needs to change
// without a deploy, which is a reasonable next step but not built here.
const REWARDS = [
  { id: "rw-1", title: "300 MB Data Voucher", cost: 300 },
  { id: "rw-2", title: "Free SMS Pack (100 SMS)", cost: 300 },
  { id: "rw-3", title: "$1 Airtime Credit", cost: 800 },
  { id: "rw-4", title: "1 GB Data Voucher", cost: 1200 },
];

export function registerMacaashRoutes(app, db) {
  app.get("/macaash/balance", requireAuth("customer"), async (ctx) => {
    const customer = db.prepare(`SELECT macaash_points FROM customers WHERE id = ?`).get(ctx.auth.sub);
    ctx.json(200, { balance: customer?.macaash_points ?? 0 });
  });

  app.get("/macaash/rewards", requireAuth("customer"), async (ctx) => {
    ctx.json(200, REWARDS);
  });

  app.post("/macaash/redeem", requireAuth("customer"), async (ctx) => {
    const reward = REWARDS.find((r) => r.id === ctx.body.rewardId);
    if (!reward) return ctx.json(404, { error: "Unknown reward" });

    const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(ctx.auth.sub);
    if (customer.macaash_points < reward.cost) return ctx.json(409, { error: "Not enough points" });

    db.prepare(`UPDATE customers SET macaash_points = macaash_points - ? WHERE id = ?`)
      .run(reward.cost, ctx.auth.sub);
    db.prepare(
      `INSERT INTO macaash_transactions (id, customer_id, points, reason) VALUES (?, ?, ?, ?)`
    ).run(randomUUID(), ctx.auth.sub, -reward.cost, `Redeemed ${reward.title}`);

    ctx.json(200, { redeemed: reward.title, remainingBalance: customer.macaash_points - reward.cost });
  });

  app.get("/macaash/history", requireAuth("customer"), async (ctx) => {
    const rows = db.prepare(
      `SELECT * FROM macaash_transactions WHERE customer_id = ? ORDER BY created_at DESC`
    ).all(ctx.auth.sub);
    ctx.json(200, rows);
  });
}
