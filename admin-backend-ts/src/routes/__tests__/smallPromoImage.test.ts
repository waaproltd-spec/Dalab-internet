// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/routes/__tests__/smallPromoImage.test.ts
//
// A large promo banner (seen live: a 1986x792 PNG of 1.4 MB that phones on
// a weak connection never finished loading) is served as a smaller copy;
// the original stays as uploaded and is still available with ?full=1.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import sharp from "sharp";
import { query, pool } from "../../db/pool.js";
import { promoImagesRouter } from "../promoImages.routes.js";

const app = express();
app.use(promoImagesRouter);
let server: http.Server;
let base: string;
const BIG = randomUUID();
const SMALL = randomUUID();
let bigPng: Buffer;
let smallPng: Buffer;

before(async () => {
  // Noise doesn't compress: a realistic, large photo-like PNG.
  bigPng = await sharp(randomBytes(1986 * 792 * 3), { raw: { width: 1986, height: 792, channels: 3 } }).png().toBuffer();
  smallPng = await sharp({ create: { width: 200, height: 80, channels: 3, background: "#123456" } }).png().toBuffer();
  const cols = await query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='promo_images'`);
  const names = cols.map((c) => c.column_name);
  const insert = async (id: string, data: Buffer, pos: number) => {
    const all: Array<[string, unknown]> = [["id", id], ["image_data", data], ["mime_type", "image/png"], ["position", pos], ["active", true]];
    const fields = all.filter(([f]) => names.includes(f));
    const placeholders = fields.map((_, i) => "$" + (i + 1)).join(",");
    await query(`INSERT INTO promo_images (${fields.map(([f]) => f).join(",")}) VALUES (${placeholders})`, fields.map(([, v]) => v));
  };
  await insert(BIG, bigPng, 901);
  await insert(SMALL, smallPng, 902);
  server = http.createServer(app as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await query(`DELETE FROM promo_images WHERE id = ANY($1)`, [[BIG, SMALL]]);
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

const get = async (p: string) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, type: r.headers.get("content-type"), body: Buffer.from(await r.arrayBuffer()) };
};

test("a large banner is sent as a much smaller JPEG at most 1280 px wide", async () => {
  const r = await get(`/promo-images/${BIG}/image`);
  assert.equal(r.status, 200);
  assert.equal(r.type, "image/jpeg");
  assert.ok(bigPng.length > 4_000_000, `test image is large (${bigPng.length})`);
  assert.ok(r.body.length < bigPng.length / 4, `${r.body.length} bytes vs ${bigPng.length}`);
  const meta = await sharp(r.body).metadata();
  assert.equal(meta.width, 1280);
  assert.equal(meta.height, Math.round((792 * 1280) / 1986));
  const again = await get(`/promo-images/${BIG}/image`);
  assert.ok(again.body.equals(r.body), "same copy the second time (kept in memory)");
});

test("?full=1 returns the original exactly as uploaded", async () => {
  const r = await get(`/promo-images/${BIG}/image?full=1`);
  assert.equal(r.type, "image/png");
  assert.ok(r.body.equals(bigPng));
});

test("a small banner is sent unchanged; a missing one is 404", async () => {
  const r = await get(`/promo-images/${SMALL}/image`);
  assert.equal(r.type, "image/png");
  assert.ok(r.body.equals(smallPng));
  assert.equal((await get(`/promo-images/${randomUUID()}/image`)).status, 404);
});
