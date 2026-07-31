import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A file path (not ":memory:") so the seed data set up in server.js persists
// across the lifetime of the process — swap this for a real Postgres connection
// string in production; every query in src/routes/*.js is plain parameterized
// SQL, so the migration is mechanical (see README.md "Moving to Postgres").
//
// Resolved lazily *inside* openDb() rather than as a module-level constant —
// server.js sets process.env.DB_PATH from buildServer()'s dbPath argument
// (used by the test suite to point at an isolated per-run database), and that
// happens after this module is first imported. A top-level `const DB_PATH =
// process.env.DB_PATH ?? ...` would freeze the default in before buildServer()
// ever runs, silently ignoring dbPath — which is exactly the bug that caused
// every "isolated" test run to actually share one leftover database file.
function resolveDbPath() {
  return process.env.DB_PATH ?? path.join(__dirname, "../../data/sahal-data.db");
}

export function openDb() {
  const db = new DatabaseSync(resolveDbPath());
  db.exec("PRAGMA foreign_keys = ON;");
  const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  return db;
}
