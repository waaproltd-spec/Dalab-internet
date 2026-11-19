/**
 * A smaller copy of a large promo banner for the Customer App.
 *
 * Admins upload banners straight from design tools -- a 1986x792 PNG of
 * 1.4 MB was seen live -- and on a weak mobile connection the app sat on a
 * gray box until (or instead of) finishing that download. Banners are
 * shown at phone width, so a copy at most 1280 px wide is plenty: JPEG at
 * quality 80 (PNG when the image has transparency, so no black corners).
 *
 * The original stays untouched in the database. Each copy is made once per
 * image version and kept in memory. If the image library can't load or a
 * file can't be shrunk, the caller sends the original, exactly as before:
 * this never turns a working banner into a broken one.
 */
const SMALL_ENOUGH_BYTES = 250 * 1024;
const MAX_WIDTH = 1280;

const cache = new Map<string, { data: Buffer; mime: string }>();

export async function smallPromoImage(
  key: string,
  original: Buffer,
  mime: string
): Promise<{ data: Buffer; mime: string }> {
  if (original.length <= SMALL_ENOUGH_BYTES || !/^image\/(png|jpe?g|webp)$/i.test(mime)) return { data: original, mime };
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const sharp = (await import("sharp")).default;
    const img = sharp(original, { failOn: "none" }).rotate();
    const meta = await img.metadata();
    const resized = img.resize({ width: MAX_WIDTH, withoutEnlargement: true });
    const small = meta.hasAlpha
      ? { data: await resized.png({ compressionLevel: 9, palette: true }).toBuffer(), mime: "image/png" }
      : { data: await resized.jpeg({ quality: 80, mozjpeg: true }).toBuffer(), mime: "image/jpeg" };
    const result = small.data.length < original.length ? small : { data: original, mime };
    if (cache.size > 50) cache.clear();
    cache.set(key, result);
    return result;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Promo image resize failed; sending the original:", (err as Error).message);
    return { data: original, mime };
  }
}
