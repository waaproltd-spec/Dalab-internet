import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";

export const categoriesRouter = Router();

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Public: the Customer/Agent apps' package browsing already groups by the
// free-text categoryId on packages; this exposes the managed name/status for
// any UI that wants a nicer label than the raw slug, and to filter out
// disabled categories from what customers/agents can browse.
categoriesRouter.get("/companies/:id/categories", async (req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT * FROM service_categories WHERE company_id=$1 AND status='enabled' ORDER BY name`,
      [req.params.id]
    )
  );
});

categoriesRouter.get("/admin/categories", requireStaff(), async (req, res) => {
  const { companyId } = req.query;
  const rows = companyId
    ? await query(`SELECT * FROM service_categories WHERE company_id=$1 ORDER BY name`, [companyId])
    : await query(`SELECT * FROM service_categories ORDER BY company_id, name`);
  sendJson(res, 200, rows);
});

categoriesRouter.post("/admin/categories", requirePermission("categories.manage"), async (req, res) => {
  const { companyId, name } = req.body;
  if (!companyId || !name) return sendJson(res, 400, { error: "companyId and name are required" });

  const company = await queryOne(`SELECT id FROM companies WHERE id=$1`, [companyId]);
  if (!company) return sendJson(res, 404, { error: "Company not found" });

  const slug = slugify(name);
  if (!slug) return sendJson(res, 400, { error: "name must contain at least one letter or number" });

  if (await queryOne(`SELECT id FROM service_categories WHERE company_id=$1 AND slug=$2`, [companyId, slug])) {
    return sendJson(res, 409, { error: "A category with this name already exists for this company" });
  }

  const row = await queryOne(
    `INSERT INTO service_categories (company_id, slug, name) VALUES ($1,$2,$3) RETURNING *`,
    [companyId, slug, name]
  );
  sendJson(res, 201, row);
});

categoriesRouter.put("/admin/categories/:id", requirePermission("categories.manage"), async (req, res) => {
  const existing = await queryOne(`SELECT * FROM service_categories WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Category not found" });

  const name = req.body.name ?? existing.name;
  const status = req.body.status ?? existing.status;
  if (!["enabled", "disabled"].includes(status)) {
    return sendJson(res, 400, { error: "status must be 'enabled' or 'disabled'" });
  }

  await query(
    `UPDATE service_categories SET name=$1, status=$2, updated_at=now() WHERE id=$3`,
    [name, status, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT * FROM service_categories WHERE id=$1`, [req.params.id]));
});

categoriesRouter.put("/admin/categories/:id/status", requirePermission("categories.manage"), async (req, res) => {
  const { status } = req.body;
  if (!["enabled", "disabled"].includes(status)) {
    return sendJson(res, 400, { error: "status must be 'enabled' or 'disabled'" });
  }
  const result = await query(
    `UPDATE service_categories SET status=$1, updated_at=now() WHERE id=$2 RETURNING id`,
    [status, req.params.id]
  );
  if (result.length === 0) return sendJson(res, 404, { error: "Category not found" });
  sendJson(res, 200, await queryOne(`SELECT * FROM service_categories WHERE id=$1`, [req.params.id]));
});

// Deleting a category never touches existing packages — categoryId on
// packages stays as-is (it's plain text, not a foreign key), it just stops
// appearing as a manageable/selectable category going forward.
categoriesRouter.delete("/admin/categories/:id", requirePermission("categories.manage"), async (req, res) => {
  const result = await query(`DELETE FROM service_categories WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Category not found" });
  sendJson(res, 200, { deleted: true });
});
