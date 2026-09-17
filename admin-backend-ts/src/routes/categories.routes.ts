import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { parseDataUri } from "../utils/dataUri.js";

export const categoriesRouter = Router();

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// icon_data must never reach any client on the list routes below — same
// "has_X boolean, raw bytes only through their own dedicated route" pattern
// as companies.logo_data/has_logo and packages.image_data/has_image.
const CATEGORY_COLUMNS = `id, company_id, slug, name, status, (icon_data IS NOT NULL) AS has_icon, created_at, updated_at`;

// Public: the Customer/Agent apps' package browsing already groups by the
// free-text categoryId on packages; this exposes the managed name/status for
// any UI that wants a nicer label than the raw slug, and to filter out
// disabled categories from what customers/agents can browse.
categoriesRouter.get("/companies/:id/categories", async (req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT ${CATEGORY_COLUMNS} FROM service_categories WHERE company_id=$1 AND status='enabled' ORDER BY name`,
      [req.params.id]
    )
  );
});

// Public — served by category id (not a secret), same reasoning as
// companies/:id/logo and packages/:id/image: an <img src> tag can't send an
// Authorization header anyway.
categoriesRouter.get("/categories/:id/icon", async (req, res) => {
  const row = await queryOne<{ icon_data: Buffer | null; icon_mime_type: string | null }>(
    `SELECT icon_data, icon_mime_type FROM service_categories WHERE id=$1`,
    [req.params.id]
  );
  if (!row || !row.icon_data) return sendJson(res, 404, { error: "Icon not found" });
  res.setHeader("Content-Type", row.icon_mime_type || "image/png");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(row.icon_data);
});

categoriesRouter.get("/admin/categories", requireStaff(), async (req, res) => {
  const { companyId } = req.query;
  const rows = companyId
    ? await query(`SELECT ${CATEGORY_COLUMNS} FROM service_categories WHERE company_id=$1 ORDER BY name`, [companyId])
    : await query(`SELECT ${CATEGORY_COLUMNS} FROM service_categories ORDER BY company_id, name`);
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

  const id = (
    await queryOne<{ id: string }>(
      `INSERT INTO service_categories (company_id, slug, name) VALUES ($1,$2,$3) RETURNING id`,
      [companyId, slug, name]
    )
  )!.id;
  sendJson(res, 201, await queryOne(`SELECT ${CATEGORY_COLUMNS} FROM service_categories WHERE id=$1`, [id]));
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
  sendJson(res, 200, await queryOne(`SELECT ${CATEGORY_COLUMNS} FROM service_categories WHERE id=$1`, [req.params.id]));
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
  sendJson(res, 200, await queryOne(`SELECT ${CATEGORY_COLUMNS} FROM service_categories WHERE id=$1`, [req.params.id]));
});

// Dedicated sub-resource rather than a field on POST/PUT /admin/categories,
// matching how the company logo (companies.routes.ts) and package image
// are each managed separately from the rest of their parent's fields.
categoriesRouter.put("/admin/categories/:id/icon", requirePermission("categories.manage"), async (req, res) => {
  const parsed = parseDataUri(req.body.iconBase64);
  if (!parsed) return sendJson(res, 400, { error: "iconBase64 must be a data:<mime>;base64,<data> string" });
  const result = await query(
    `UPDATE service_categories SET icon_data=$1, icon_mime_type=$2, updated_at=now() WHERE id=$3 RETURNING id`,
    [parsed.data, parsed.mimeType, req.params.id]
  );
  if (result.length === 0) return sendJson(res, 404, { error: "Category not found" });
  sendJson(res, 200, await queryOne(`SELECT ${CATEGORY_COLUMNS} FROM service_categories WHERE id=$1`, [req.params.id]));
});

categoriesRouter.delete("/admin/categories/:id/icon", requirePermission("categories.manage"), async (req, res) => {
  const result = await query(
    `UPDATE service_categories SET icon_data=NULL, icon_mime_type=NULL, updated_at=now() WHERE id=$1 RETURNING id`,
    [req.params.id]
  );
  if (result.length === 0) return sendJson(res, 404, { error: "Category not found" });
  sendJson(res, 200, await queryOne(`SELECT ${CATEGORY_COLUMNS} FROM service_categories WHERE id=$1`, [req.params.id]));
});

// Deleting a category never touches existing packages — categoryId on
// packages stays as-is (it's plain text, not a foreign key), it just stops
// appearing as a manageable/selectable category going forward.
categoriesRouter.delete("/admin/categories/:id", requirePermission("categories.manage"), async (req, res) => {
  const result = await query(`DELETE FROM service_categories WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Category not found" });
  sendJson(res, 200, { deleted: true });
});
