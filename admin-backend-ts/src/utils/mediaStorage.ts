import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { query, queryOne } from "../db/pool.js";
import { parseDataUri } from "./dataUri.js";

/**
 * Uploaded images (Ciyaaraha match pictures and team logos) are kept as
 * files on the server's disk -- not as BYTEA in Postgres -- under MEDIA_DIR
 * (default /var/lib/dalab/media). media_images holds only the metadata the
 * cleanup job needs: what the file is for, who uploaded it, and whether it
 * may be deleted.
 */
export const MEDIA_MAX_BYTES = 2 * 1024 * 1024;
export type MediaPurpose = "contest_image" | "team_logo";

export function mediaDir(): string {
  return process.env.MEDIA_DIR || "/var/lib/dalab/media";
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** The real type from the file's first bytes; the declared type is not trusted. */
export function sniffImageType(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export class MediaError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export async function saveImage(
  dataUri: unknown,
  purpose: MediaPurpose,
  uploader: { agentId?: string; adminId?: string }
): Promise<{ id: string; mimeType: string; sizeBytes: number }> {
  const parsed = parseDataUri(dataUri);
  if (!parsed || parsed.data.length === 0) throw new MediaError("imageBase64 must be a data URI (data:image/...;base64,...)");
  if (parsed.data.length > MEDIA_MAX_BYTES) throw new MediaError("Image is too large (max 2 MB)", 413);
  const mimeType = sniffImageType(parsed.data);
  if (!mimeType) throw new MediaError("Only PNG, JPEG or WebP images are accepted");

  const id = randomUUID();
  const month = new Date().toISOString().slice(0, 7);
  const storageKey = `${month}/${id}.${EXT[mimeType]}`;
  const full = path.join(mediaDir(), storageKey);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, parsed.data, { flag: "wx" });
  try {
    await query(
      `INSERT INTO media_images (id, storage_key, mime_type, size_bytes, purpose, uploaded_by_agent_id, uploaded_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, storageKey, mimeType, parsed.data.length, purpose, uploader.agentId ?? null, uploader.adminId ?? null]
    );
  } catch (err) {
    await fs.rm(full, { force: true });
    throw err;
  }
  return { id, mimeType, sizeBytes: parsed.data.length };
}

export async function readImage(id: string): Promise<{ data: Buffer; mimeType: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await queryOne<{ storage_key: string; mime_type: string }>(
    `SELECT storage_key, mime_type FROM media_images WHERE id=$1 AND status='active'`,
    [id]
  );
  if (!row) return null;
  try {
    return { data: await fs.readFile(path.join(mediaDir(), row.storage_key)), mimeType: row.mime_type };
  } catch {
    return null;
  }
}

/** True while a contest or a team still points at this image. */
export async function imageInUse(id: string): Promise<boolean> {
  const r = await queryOne<{ used: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM football_contests WHERE image_id=$1)
         OR EXISTS(SELECT 1 FROM football_teams WHERE logo_image_id=$1) AS used`,
    [id]
  );
  return Boolean(r?.used);
}

/** Removes one file from disk (missing is fine) and marks the row deleted. */
export async function deleteImageFile(id: string, storageKey: string): Promise<void> {
  await fs.rm(path.join(mediaDir(), storageKey), { force: true });
  await query(`UPDATE media_images SET status='deleted', deleted_at=now(), delete_error=NULL WHERE id=$1`, [id]);
}
