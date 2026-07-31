import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { parseDataUri } from "../utils/dataUri.js";

export const promoImagesRouter = Router();

// image_data (BYTEA) is deliberately never selected here — it's only ever
// read by the dedicated .../image route below, served raw rather than
// through sendJson (which would otherwise try to camelCase-walk the Buffer).
const PROMO_IMAGE_COLUMNS = "id, mime_type, position, active, created_at";
const MAX_ACTIVE_PROMO_IMAGES = 5;

promoImagesRouter.get("/promo-images", async (_req, res) => {
  const rows = await query(
    `SELECT ${PROMO_IMAGE_COLUMNS} FROM promo_images WHERE active=true ORDER BY position`
  );
  sendJson(res, 200, rows);
});

// Not gated by `active` — served by unguessable UUID, and the content
// itself is public-facing marketing material either way, so the dashboard's
// <img> tags can point straight at this route (including for a currently
// inactive image, so its thumbnail still renders while toggled off) without
// needing an Authorization header, which <img src> can't send anyway.
promoImagesRouter.get("/promo-images/:id/image", async (req, res) => {
  const row = await queryOne<{ image_data: Buffer; mime_type: string }>(
    `SELECT image_data, mime_type FROM promo_images WHERE id=$1`,
    [req.params.id]
  );
  if (!row) return sendJson(res, 404, { error: "Image not found" });
  res.setHeader("Content-Type", row.mime_type);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(row.image_data);
});

promoImagesRouter.get("/admin/promo-images", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT ${PROMO_IMAGE_COLUMNS} FROM promo_images ORDER BY position`));
});

promoImagesRouter.post("/admin/promo-images", requireStaff(), async (req, res) => {
  const parsed = parseDataUri(req.body.imageBase64);
  if (!parsed) return sendJson(res, 400, { error: "imageBase64 must be a data:<mime>;base64,<data> string" });

  const activeCount = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM promo_images WHERE active=true`);
  if (Number(activeCount?.n ?? 0) >= MAX_ACTIVE_PROMO_IMAGES) {
    return sendJson(res, 400, { error: `Maximum ${MAX_ACTIVE_PROMO_IMAGES} promotional images allowed — remove one first` });
  }

  const id = randomUUID();
  const maxPos = await queryOne<{ m: number }>(`SELECT COALESCE(MAX(position), 0) AS m FROM promo_images`);
  await query(
    `INSERT INTO promo_images (id, image_data, mime_type, position) VALUES ($1,$2,$3,$4)`,
    [id, parsed.data, parsed.mimeType, (maxPos?.m ?? 0) + 1]
  );
  sendJson(res, 201, await queryOne(`SELECT ${PROMO_IMAGE_COLUMNS} FROM promo_images WHERE id=$1`, [id]));
});

promoImagesRouter.put("/admin/promo-images/:id", requireStaff(), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM promo_images WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Image not found" });
  const active = req.body.active;
  const position = req.body.position;
  await query(
    `UPDATE promo_images SET active=COALESCE($1, active), position=COALESCE($2, position) WHERE id=$3`,
    [typeof active === "boolean" ? active : null, typeof position === "number" ? position : null, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT ${PROMO_IMAGE_COLUMNS} FROM promo_images WHERE id=$1`, [req.params.id]));
});

promoImagesRouter.delete("/admin/promo-images/:id", requireStaff(), async (req, res) => {
  const result = await query(`DELETE FROM promo_images WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Image not found" });
  sendJson(res, 200, { deleted: true });
});
