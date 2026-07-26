import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";

export const bannersRouter = Router();

bannersRouter.get("/banners", async (_req, res) => {
  const rows = await query(
    `SELECT * FROM banners WHERE active=true
     AND (start_date IS NULL OR start_date <= CURRENT_DATE)
     AND (end_date IS NULL OR end_date >= CURRENT_DATE)
     ORDER BY position`
  );
  sendJson(res, 200, rows);
});

bannersRouter.get("/admin/banners", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM banners ORDER BY position`));
});

bannersRouter.post("/admin/banners", requireStaff(), async (req, res) => {
  const { title, subtitle, gradient, targetCompanyId, startDate, endDate } = req.body;
  if (!title) return sendJson(res, 400, { error: "title is required" });
  const id = randomUUID();
  const maxPos = await queryOne<{ m: number }>(`SELECT COALESCE(MAX(position), 0) AS m FROM banners`);
  await query(
    `INSERT INTO banners (id, title, subtitle, gradient, target_company_id, position, start_date, end_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, title, subtitle ?? "", gradient ?? "", targetCompanyId ?? null, (maxPos?.m ?? 0) + 1, startDate ?? null, endDate ?? null]
  );
  sendJson(res, 201, await queryOne(`SELECT * FROM banners WHERE id=$1`, [id]));
});

bannersRouter.put("/admin/banners/:id", requireStaff(), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM banners WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Banner not found" });
  const merged = { ...existing, ...req.body };
  await query(
    `UPDATE banners SET title=$1, subtitle=$2, gradient=$3, active=$4, position=$5, start_date=$6, end_date=$7 WHERE id=$8`,
    [merged.title, merged.subtitle, merged.gradient, Boolean(merged.active), merged.position, merged.start_date, merged.end_date, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM banners WHERE id=$1`, [req.params.id]));
});

bannersRouter.delete("/admin/banners/:id", requireStaff(), async (req, res) => {
  const result = await query(`DELETE FROM banners WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Banner not found" });
  sendJson(res, 200, { deleted: true });
});
