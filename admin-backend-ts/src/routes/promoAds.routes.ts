import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";
import { parseDataUri } from "../utils/dataUri.js";
import { readImageDimensions } from "../utils/imageDimensions.js";

export const promoAdsRouter = Router();

// Every Promo Ad image must be exactly this size/aspect ratio -- the
// Customer App's mandatory full-screen launch carousel (PromoAdLaunchScreen,
// entirely separate from the Home banner, which is /promo-images) renders
// these at a fixed 16:9 frame, so a mismatched upload would only ever show
// cropped or distorted. Enforced here (not just in the Agent App's own
// picker) since this is the actual system boundary for the upload.
const PROMO_AD_IMAGE_WIDTH = 1280;
const PROMO_AD_IMAGE_HEIGHT = 720;

function validatePromoAdImage(data: Buffer): string | null {
  const dims = readImageDimensions(data);
  if (!dims) return "Image must be a JPEG or PNG file.";
  if (dims.width !== PROMO_AD_IMAGE_WIDTH || dims.height !== PROMO_AD_IMAGE_HEIGHT) {
    return `Image must be exactly ${PROMO_AD_IMAGE_WIDTH}x${PROMO_AD_IMAGE_HEIGHT}px (16:9) -- got ${dims.width}x${dims.height}.`;
  }
  return null;
}

// Full customer-management power the Agent App already has elsewhere
// (customers.routes.ts's own doc comment: "Same customer-management power
// Admin has") extends here too -- any authenticated agent can manage the
// promo ad popup shown to every customer, same trust model, no separate
// per-agent scoping.
const requireAgent = () => requireAuth("agent");

// image_data (BYTEA) is deliberately never selected here -- only ever read
// by the dedicated .../image route below, served raw rather than through
// sendJson (which would otherwise try to camelCase-walk the Buffer). Same
// pattern as promo_images/companies' own logo route.
const PROMO_AD_COLUMNS = "id, mime_type, title, body, enabled, position, created_at, updated_at";

// ---------------- Customer App (public) ----------------

// Deliberately a separate feature from GET /promo-images (the existing
// inline Home-screen carousel banner) -- this is the full-screen popup
// shown once per 24h on app open, with its own headline/body text.
promoAdsRouter.get("/promo-ads", async (_req, res) => {
  const rows = await query(
    `SELECT ${PROMO_AD_COLUMNS} FROM promo_ads WHERE enabled=true ORDER BY position`
  );
  sendJson(res, 200, rows);
});

// Not gated by `enabled` -- served by unguessable UUID, and an <img>/
// Image.network tag can't send an Authorization header anyway (same
// reasoning as promo-images/:id/image and companies/:id/logo).
promoAdsRouter.get("/promo-ads/:id/image", async (req, res) => {
  const row = await queryOne<{ image_data: Buffer; mime_type: string }>(
    `SELECT image_data, mime_type FROM promo_ads WHERE id=$1`,
    [req.params.id]
  );
  if (!row) return sendJson(res, 404, { error: "Image not found" });
  res.setHeader("Content-Type", row.mime_type);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(row.image_data);
});

// ---------------- Agent App (management) ----------------

promoAdsRouter.get("/agent/promo-ads", requireAgent(), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT ${PROMO_AD_COLUMNS} FROM promo_ads ORDER BY position`));
});

promoAdsRouter.post("/agent/promo-ads", requireAgent(), async (req, res) => {
  const parsed = parseDataUri(req.body.imageBase64);
  if (!parsed) return sendJson(res, 400, { error: "imageBase64 must be a data:<mime>;base64,<data> string" });
  const imageError = validatePromoAdImage(parsed.data);
  if (imageError) return sendJson(res, 400, { error: imageError });
  const title = req.body.title != null ? String(req.body.title).trim() : null;
  const body = req.body.body != null ? String(req.body.body).trim() : null;

  const id = randomUUID();
  const maxPos = await queryOne<{ m: number }>(`SELECT COALESCE(MAX(position), -1) AS m FROM promo_ads`);
  await query(
    `INSERT INTO promo_ads (id, image_data, mime_type, title, body, position) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, parsed.data, parsed.mimeType, title || null, body || null, (maxPos?.m ?? -1) + 1]
  );
  sendJson(res, 201, await queryOne(`SELECT ${PROMO_AD_COLUMNS} FROM promo_ads WHERE id=$1`, [id]));
});

// Image replacement is optional -- omitting imageBase64 keeps the existing
// image, same as title/body being omitted keeps their existing values.
promoAdsRouter.put("/agent/promo-ads/:id", requireAgent(), async (req, res) => {
  const existing = await queryOne(`SELECT id FROM promo_ads WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Ad not found" });

  const title = req.body.title !== undefined ? String(req.body.title ?? "").trim() || null : undefined;
  const body = req.body.body !== undefined ? String(req.body.body ?? "").trim() || null : undefined;
  let imageData: Buffer | undefined;
  let mimeType: string | undefined;
  if (req.body.imageBase64 !== undefined) {
    const parsed = parseDataUri(req.body.imageBase64);
    if (!parsed) return sendJson(res, 400, { error: "imageBase64 must be a data:<mime>;base64,<data> string" });
    const imageError = validatePromoAdImage(parsed.data);
    if (imageError) return sendJson(res, 400, { error: imageError });
    imageData = parsed.data;
    mimeType = parsed.mimeType;
  }

  await query(
    `UPDATE promo_ads SET
       title=COALESCE($1, title),
       body=COALESCE($2, body),
       image_data=COALESCE($3, image_data),
       mime_type=COALESCE($4, mime_type),
       updated_at=now()
     WHERE id=$5`,
    [title, body, imageData ?? null, mimeType ?? null, req.params.id]
  );
  sendJson(res, 200, await queryOne(`SELECT ${PROMO_AD_COLUMNS} FROM promo_ads WHERE id=$1`, [req.params.id]));
});

promoAdsRouter.put("/agent/promo-ads/:id/status", requireAgent(), async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") return sendJson(res, 400, { error: "enabled must be a boolean" });
  const existing = await queryOne(`SELECT id FROM promo_ads WHERE id=$1`, [req.params.id]);
  if (!existing) return sendJson(res, 404, { error: "Ad not found" });
  await query(`UPDATE promo_ads SET enabled=$1, updated_at=now() WHERE id=$2`, [enabled, req.params.id]);
  sendJson(res, 200, await queryOne(`SELECT ${PROMO_AD_COLUMNS} FROM promo_ads WHERE id=$1`, [req.params.id]));
});

// Body: { orderedIds: string[] } -- every ad's own id, in the exact order
// the agent wants them shown. Assigns position 0..n-1 in that order, all in
// one transaction so a request that dies partway through never leaves the
// list in a half-reordered state. Any id not in the current table is
// silently ignored rather than erroring -- the caller's own list, fetched
// moments earlier, is trusted as of "now"; a concurrent delete of one ad
// mid-reorder shouldn't fail the whole request.
promoAdsRouter.put("/agent/promo-ads/reorder", requireAgent(), async (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== "string")) {
    return sendJson(res, 400, { error: "orderedIds must be an array of ad ids" });
  }
  await withTransaction(async (client) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(`UPDATE promo_ads SET position=$1, updated_at=now() WHERE id=$2`, [i, orderedIds[i]]);
    }
  });
  sendJson(res, 200, await query(`SELECT ${PROMO_AD_COLUMNS} FROM promo_ads ORDER BY position`));
});

promoAdsRouter.delete("/agent/promo-ads/:id", requireAgent(), async (req, res) => {
  const result = await query(`DELETE FROM promo_ads WHERE id=$1 RETURNING id`, [req.params.id]);
  if (result.length === 0) return sendJson(res, 404, { error: "Ad not found" });
  sendJson(res, 200, { deleted: true });
});
