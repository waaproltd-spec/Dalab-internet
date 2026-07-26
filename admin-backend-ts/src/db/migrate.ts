import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Applies 001_init.sql against DATABASE_URL. Every statement uses
 * CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, so this is safe
 * to run on every deploy (Render's build step calls `npm run migrate`
 * automatically — see render.yaml) without a migration-tracking table; for
 * a schema change beyond this initial version, add 002_*.sql and extend the
 * `files` array below rather than editing 001 in place.
 */
async function migrate() {
  const files = ["001_init.sql", "002_admin_controls.sql"];
  for (const file of files) {
    const sql = readFileSync(path.join(__dirname, "migrations", file), "utf8");
    // eslint-disable-next-line no-console
    console.log(`Applying migration: ${file}`);
    await pool.query(sql);
  }
  // eslint-disable-next-line no-console
  console.log("Migrations complete.");
  await pool.end();
}

migrate().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Migration failed:", err);
  process.exit(1);
});
