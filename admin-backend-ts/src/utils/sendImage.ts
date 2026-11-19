import { createHash } from "node:crypto";
import type { Request, Response } from "express";

/**
 * Sends an image that can be replaced (company logo, package / category /
 * shop / promo image...) so a phone or browser always sees the current one.
 * The image's URL never changes when it is replaced, so a long
 * "max-age" cache kept showing the old picture for up to an hour (an
 * uploaded Amtel logo didn't appear). Now every request revalidates: an
 * unchanged image costs only a tiny 304 answer, a replaced one arrives at
 * once. Works whether or not the app has Express's own ETags switched on.
 */
export function sendImage(req: Request, res: Response, data: Buffer): void {
  const etag = `"${createHash("sha1").update(data.toString("base64")).digest("base64url")}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "no-cache");
  const seen = String(req.headers["if-none-match"] ?? "").split(",").map((t) => t.trim().replace(/^W\//, ""));
  if (seen.includes(etag)) {
    res.status(304).end();
    return;
  }
  res.send(data);
}
