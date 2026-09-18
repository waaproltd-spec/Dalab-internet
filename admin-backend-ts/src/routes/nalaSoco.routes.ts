import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { parseDataUri } from "../utils/dataUri.js";

export const nalaSocoRouter = Router();

// image_data (BYTEA) is deliberately never selected here -- it's only ever
// read by the dedicated .../image route below, served raw rather than
// through sendJson (which would otherwise try to camelCase-walk the
// Buffer). hasImage lets a list view know whether to render an <img> tag
// at all without fetching the image itself.
const NALA_SOCO_LIST_COLUMNS =
  "id, title, body, (image_data IS NOT NULL) AS has_image, published, created_at, updated_at";

const MAX_PAGE_SIZE = 50;

nalaSocoRouter.get("/nala-soco", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, MAX_PAGE_SIZE);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const rows = await query(
    `SELECT ${NALA_SOCO_LIST_COLUMNS} FROM nala_soco_posts WHERE published=true ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  sendJson(res, 200, rows);
});

// Not gated by `published` -- served by unguessable UUID, and the Admin
// dashboard's own <img> preview needs to keep working for an unpublished
// draft post too, same reasoning as promo_images' own image route (an
// <img src> tag can't send an Authorization header anyway).
nalaSocoRouter.get("/nala-soco/:id/image", async (req, res) => {
  const row = await queryOne<{ image_data: Buffer | null; image_mime_type: string | null }>(
    `SELECT image_data, image_mime_type FROM nala_soco_posts WHERE id=$1`,
    [req.params.id]
  );
  if (!row || !row.image_data || !row.image_mime_type) return sendJson(res, 404, { error: "Image not found" });
  res.setHeader("Content-Type", row.image_mime_type);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(row.image_data);
});

nalaSocoRouter.get("/admin/nala-soco", requireStaff(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT ${NALA_SOCO_LIST_COLUMNS} FROM nala_soco_posts ORDER BY created_at DESC`));
});

nalaSocoRouter.post("/admin/nala-soco", requireStaff(), async (req, res) => {
  const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
  const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
  if (!title) return sendJson(res, 400, { error: "title is required" });
  if (!body) return sendJson(res, 400, { error: "body is required" });

  // Optional -- a post can be text-only, unlike promo_images where the
  // image IS the whole point.
  const parsedImage = req.body.imageBase64 ? parseDataUri(req.body.imageBase64) : null;
  if (req.body.imageBase64 && !parsedImage) {
    return sendJson(res, 400, { error: "imageBase64 must be a data:<mime>;base64,<data> string" });
  }
  const published = typeof req.body.published === "boolean" ? req.body.published : true;

  const id = randomUUID();
  await query(
    `INSERT INTO nala_soco_posts (id, title, body, image_data, image_mime_type, published, created_by_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, title, body, parsedImage?.data ?? null, parsedImage?.mimeType ?? null, published, req.auth!.sub]
  );
  sendJson(res, 201, await queryOne(`SELECT ${NALA_SOCO_LIST_COLUMNS} FROM nala_soco_posts WHERE id=$1`, [id]));
});

nalaSocoRouter.put("/admin/nala-soco/:id", requireStaff(), async (req, res) => {
  const existing = await queryOne<{ title: string; body: string; published: boolean }>(
    `SELECT title, body, published FROM nala_soco_posts WHERE id=$1`,
    [req.params.id]
  );
  if (!existing) return sendJson(res, 404, { error: "Post not found" });

  const title = typeof req.body.title === "string" ? req.body.title.trim() : existing.title;
  const body = typeof req.body.body === "string" ? req.body.body.trim() : existing.body;
  if (!title) return sendJson(res, 400, { error: "title is required" });
  if (!body) return sendJson(res, 400, { error: "body is required" });
  const published = typeof req.body.published === "boolean" ? req.body.published : existing.published;

  // Only touches the image columns when a new one is actually sent --
  // omitting imageBase64 on an update must never silently wipe an existing
  // image. To actually remove an image, the caller sends imageBase64: null
  // explicitly.
  if (req.body.imageBase64 === null) {
    await query(`UPDATE nala_soco_posts SET title=$1, body=$2, published=$3, image_data=NULL, image_mime_type=NULL, updated_at=now() WHERE id=$4`, [
      title,
      body,
      published,
      req.params.id,
    ]);
  } else if (typeof req.body.imageBase64 === "string") {
    const parsedImage = parseDataUri(req.body.imageBase64);
    if (!parsedImage) return sendJson(res, 400, { error: "imageBase64 must be a data:<mime>;base64,<data> string" });
    await query(
      `UPDATE nala_soco_posts SET title=$1, body=$2, published=$3, image_data=$4, image_mime_type=$5, updated_at=now() WHERE id=$6`,
      [title, body, published, parsedImage.data, parsedImage.mimeType, req.params.id]
    );
  } else {
    await query(`UPDATE nala_soco_posts SET title=$1, body=$2, published=$3, updated_at=now() WHERE id=$4`, [
      title,
      body,
      published,
      req.params.id,
    ]);
  }
  sendJson(res, 200, await queryOne(`SELECT ${NALA_SOCO_LIST_COLUMNS} FROM nala_soco_posts WHERE id=$1`, [req.params.id]));
});

nalaSocoRouter.delete("/admin/nala-soco/:id", requireStaff(), async (req, res) => {
  const result = await query(`DELETE FROM nala_soco_posts WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Post not found" });
  sendJson(res, 200, { deleted: true });
});
