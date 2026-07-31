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
  const result = await pool.query(text, params);
  return result.rows as T[];
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
