import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Applies every NNN_*.sql file in ./migrations, in filename order, against
 * DATABASE_URL. Every statement uses CREATE TABLE IF NOT EXISTS / ADD COLUMN
 * IF NOT EXISTS / etc., so replaying the full set on every deploy (Render's
 * build step calls `npm run migrate` automatically — see render.yaml) is
 * safe without a migration-tracking table.
 *
 * Discovers files by scanning the directory rather than a hardcoded list —
 * a hardcoded list silently skips any migration whose filename someone
 * forgets to add to it, which is exactly what happened to 039 and 040 here.
 * Adding a new NNN_*.sql file to this directory is now the only step
 * required.
 */
async function migrate() {
  const migrationsDir = path.join(__dirname, "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
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
