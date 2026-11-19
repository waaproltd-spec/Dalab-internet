// Run against a real local Postgres test database:
//   DATABASE_URL=postgres://... PGSSL=false npx tsx --test --test-force-exit src/routes/__tests__/imageRevalidation.test.ts
//
// A replaced image (here a company logo) shows at once: images are no
// longer cached for an hour under an unchanging URL; every request
// revalidates, and an unchanged image is answered with a tiny 304.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import "express-async-errors";
import { query, pool } from "../../db/pool.js";
import { companiesRouter } from "../companies.routes.js";

const app = express();
app.use(companiesRouter);
let server: http.Server;
let base: string;
const company = "logo-test-" + randomUUID().slice(0, 8);
const OLD = Buffer.from("old-logo-bytes");
const NEW = Buffer.from("new-logo-bytes-replaced");

before(async () => {
  await query(
    `INSERT INTO companies (id, name, group_number, color_hex, logo_data, logo_mime_type) VALUES ($1,'Logo Test',2,'#C81E2C',$2,'image/png')`,
    [company, OLD]
  );
  server = http.createServer(app as unknown as http.RequestListener).listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

test("a replaced logo is served at once; an unchanged one costs a 304", async () => {
  const first = await fetch(`${base}/companies/${company}/logo`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-cache", "never kept for an hour");
  const etag = first.headers.get("etag");
  assert.ok(etag);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), OLD);

  const again = await fetch(`${base}/companies/${company}/logo`, { headers: { "If-None-Match": etag! } });
  assert.equal(again.status, 304, "unchanged: nothing re-downloaded");

  await query(`UPDATE companies SET logo_data=$2 WHERE id=$1`, [company, NEW]);
  const replaced = await fetch(`${base}/companies/${company}/logo`, { headers: { "If-None-Match": etag! } });
  assert.equal(replaced.status, 200, "the new logo comes at once");
  assert.notEqual(replaced.headers.get("etag"), etag);
  assert.deepEqual(Buffer.from(await replaced.arrayBuffer()), NEW);
});
