import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";

/**
 * Reseller Withdraw's own SIM routing — company -> device + physical slot,
 * deliberately its own table (reseller_withdrawal_sim_routing, migration
 * 058) separate from the existing sim_routing used by Internet Store/eBadal
 * recharge, so a payout line can be managed independently of the recharge
 * line for the same company. Route shape mirrors ussd.routes.ts's existing
 * /admin/sim-routing endpoints closely on purpose (same upsert-by-company
 * +device-id semantics, same priority-ranked multi-device support) —
 * reusing that proven pattern rather than inventing a new one, per product
 * instruction to reuse the existing architecture.
 */
export const resellerWithdrawalSimRoutingRouter = Router();

resellerWithdrawalSimRoutingRouter.get("/admin/reseller-withdrawal-sim-routing", requireStaff(), async (_req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT sr.*, c.name AS company_name, d.name AS device_name
       FROM reseller_withdrawal_sim_routing sr
       JOIN companies c ON c.id = sr.company_id
       LEFT JOIN agent_devices d ON d.id = sr.device_id
       ORDER BY sr.company_id, sr.priority`
    )
  );
});

resellerWithdrawalSimRoutingRouter.put(
  "/admin/reseller-withdrawal-sim-routing/:companyId/:deviceId",
  requireAuth("super_admin"),
  async (req, res) => {
    const { simSlot, mobileNumber, active, priority } = req.body;
    if (![1, 2].includes(simSlot)) return sendJson(res, 400, { error: "simSlot must be 1 or 2" });
    const company = await queryOne(`SELECT id FROM companies WHERE id=$1`, [req.params.companyId]);
    if (!company) return sendJson(res, 404, { error: "Company not found" });
    if (!(await queryOne(`SELECT id FROM agent_devices WHERE id=$1`, [req.params.deviceId]))) {
      return sendJson(res, 404, { error: "Device not found" });
    }

    await query(
      `INSERT INTO reseller_withdrawal_sim_routing (company_id, device_id, sim_slot, mobile_number, active, priority, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (company_id, device_id) DO UPDATE SET
         sim_slot=excluded.sim_slot, mobile_number=excluded.mobile_number, active=excluded.active,
         priority=excluded.priority, updated_by=excluded.updated_by, updated_at=now()`,
      [req.params.companyId, req.params.deviceId, simSlot, mobileNumber ?? null, active ?? true, priority ?? 1, req.auth!.sub]
    );
    sendJson(
      res,
      200,
      await queryOne(`SELECT * FROM reseller_withdrawal_sim_routing WHERE company_id=$1 AND device_id=$2`, [
        req.params.companyId,
        req.params.deviceId,
      ])
    );
  }
);

resellerWithdrawalSimRoutingRouter.delete(
  "/admin/reseller-withdrawal-sim-routing/:companyId/:deviceId",
  requireAuth("super_admin"),
  async (req, res) => {
    const result = await query(
      `DELETE FROM reseller_withdrawal_sim_routing WHERE company_id=$1 AND device_id=$2 RETURNING company_id`,
      [req.params.companyId, req.params.deviceId]
    );
    if (result.length === 0) return sendJson(res, 404, { error: "Route not found" });
    sendJson(res, 200, { deleted: true });
  }
);

// Agent App: scoped to its own device via ?deviceId=, and only ever returns
// active=true routes — an inactive route must never be dialable, and
// filtering it out here (rather than trusting the client to respect the
// flag) is what actually enforces "Admin disables SIM 1 -> system does not
// use it" without needing a second server-side check at dial-report time.
resellerWithdrawalSimRoutingRouter.get("/agent/reseller-withdrawal-sim-routing", requireAuth("agent"), async (req, res) => {
  const { deviceId } = req.query;
  const rows = deviceId
    ? await query(
        `SELECT sr.company_id AS "companyId", sr.device_id AS "deviceId", sr.sim_slot AS "simSlot",
                sr.mobile_number AS "mobileNumber", c.name AS "companyName"
         FROM reseller_withdrawal_sim_routing sr JOIN companies c ON c.id=sr.company_id
         WHERE sr.device_id=$1 AND sr.active=true`,
        [deviceId]
      )
    : await query(
        `SELECT sr.company_id AS "companyId", sr.device_id AS "deviceId", sr.sim_slot AS "simSlot",
                sr.mobile_number AS "mobileNumber", c.name AS "companyName"
         FROM reseller_withdrawal_sim_routing sr JOIN companies c ON c.id=sr.company_id
         WHERE sr.active=true`
      );
  sendJson(res, 200, rows);
});
