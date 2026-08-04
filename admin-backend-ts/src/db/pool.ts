import { Pool, PoolClient, PoolConfig } from "pg";

/**
 * A single shared pg Pool for the whole process — the standard pattern for
 * Node + Postgres. Render's managed Postgres gives you a DATABASE_URL
 * connection string directly; that's the only thing this needs in production.
 * SSL is required by Render's Postgres for external/managed connections, but
 * `rejectUnauthorized: false` is what you need for Render's self-signed
 * setup specifically (their own docs recommend this for the standard plan).
 */
function buildConfig(): PoolConfig {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Provide a PostgreSQL connection string (Render's managed Postgres add-on provides one automatically once linked — see render.yaml)."
    );
  }
  return {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX ?? 10),
    // Previously unset, so a query that couldn't get a free connection (pool
    // contention) or got stuck server-side just hung forever — nothing threw,
    // nothing rejected, nothing logged, and the customer app's own 45s
    // client-side timeout was the only thing that ever ended the wait. These
    // three keep every failure mode bounded well under that 45s so a real,
    // specific error actually reaches the client and gets logged (see
    // query()'s catch block below) instead of silently hanging.
    connectionTimeoutMillis: 10_000, // max wait for a free connection from the pool
    statement_timeout: 15_000, // Postgres-side per-query cutoff (session SET on connect)
    query_timeout: 20_000, // client-side belt-and-suspenders
  };
}

export const pool = new Pool(buildConfig());

pool.on("error", (err) => {
  // A background/idle client error should never crash the whole process —
  // log it and let the pool recover, which is pg's documented behavior.
  // eslint-disable-next-line no-console
  console.error("Unexpected PostgreSQL pool error:", err);
});

export async function query<T = any>(text: string, params?: unknown[]): Promise<T[]> {
  const startedAt = Date.now();
  try {
    const result = await pool.query(text, params);
    return result.rows as T[];
  } catch (err) {
    // The one place every route's DB call passes through — logging here
    // once covers every route instead of scattering try/catch per handler.
    // Query text only (truncated), never params, so a phone number/PIN/token
    // passed as a bound parameter never ends up in a log line.
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code;
    // eslint-disable-next-line no-console
    console.error(
      `Query failed after ${elapsedMs}ms${code ? ` (${code})` : ""}: ${message} -- ${text.slice(0, 120)}`
    );
    throw err;
  }
}

export async function queryOne<T = any>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs `fn` inside a single checked-out client wrapped in BEGIN/COMMIT, for
 * the rare case where a read (e.g. a SELECT ... FOR UPDATE) and a subsequent
 * write must be atomic together — every other write in this codebase is a
 * single guarded statement (UPDATE ... WHERE status=... RETURNING, or an
 * INSERT-catch-23505) and doesn't need this. Always releases the client,
 * even on error.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
