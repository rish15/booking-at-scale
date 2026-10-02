// Raw `pg` — no ORM. This is deliberate (see ARCHITECTURE.md): the
// correctness of this service depends on exact, hand-written SQL running
// inside precisely-controlled transactions (conditional UPDATEs, an
// advisory lock, ON CONFLICT). An ORM would fight that, not help it.
//
// Two pools, on purpose:
//   - `pool`     — the main request-serving pool, bounded, used by every
//                  business-logic query.
//   - `healthPool` — a tiny, separate pool used only by /readyz, so a
//                  readiness check never competes with live request
//                  traffic for a connection out of the main pool (see
//                  ARCHITECTURE.md §6).
//
// Note on prepared statements: node-postgres sends parameterized queries
// via the extended protocol as *unnamed* statements per call — it does not
// cache/reuse named prepared statements across calls the way some ORMs do.
// That's what makes it safe under PgBouncer's transaction-pooling mode
// without extra configuration. If a query builder or ORM is ever added
// later, this assumption must be re-verified.

import { Pool, PoolClient } from "pg";
import { config } from "../config/config";
import { translatePgError } from "./pgErrors";

function useSsl(): boolean {
  // Local docker-compose Postgres/PgBouncer has no TLS listener.
  // Neon (and most managed Postgres) requires TLS.
  return config.env !== "local";
}

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.db.poolMax,
  ssl: useSsl() ? { rejectUnauthorized: false } : undefined,
});

// Deliberately tiny — this pool only ever serves `SELECT 1` from /readyz.
export const healthPool = new Pool({
  connectionString: config.databaseUrl,
  max: 2,
  ssl: useSsl() ? { rejectUnauthorized: false } : undefined,
});

async function applySessionGuards(client: PoolClient): Promise<void> {
  // statement_timeout / lock_timeout: both map to real Postgres error codes
  // (57014 query_canceled, 55P03 lock_not_available) that the transaction
  // helper below catches and turns into a clean 409/429 — never a bare 500.
  // lock_timeout also bounds pg_advisory_xact_lock, which is what protects
  // the pool from one user's own request pile-up hogging connections.
  await client.query(
    `SET statement_timeout = ${config.db.statementTimeoutMs}; SET lock_timeout = ${config.db.lockTimeoutMs};`
  );
}

pool.on("connect", (client) => {
  applySessionGuards(client).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("failed to apply session guards on new connection", err);
  });
});

export async function checkDbConnection(): Promise<boolean> {
  try {
    await healthPool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `fn` inside a single Postgres transaction. Guarantees:
 *   - the connection is ALWAYS released back to the pool (try/finally),
 *     which matters specifically under PgBouncer transaction-pooling mode
 *     (see ARCHITECTURE.md §6) — a dangling open transaction would
 *     otherwise quietly starve the bounded pool during a burst.
 *   - any thrown error — including Postgres timeout errors — rolls back
 *     before propagating, so a declined request never leaves partial state.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // eslint-disable-next-line no-console
      console.error("rollback itself failed", rollbackErr);
    }
    // Centralized here so every caller of withTransaction automatically
    // gets statement_timeout/lock_timeout errors turned into OverloadedError
    // instead of needing to remember this at every call site.
    throw translatePgError(err);
  } finally {
    client.release();
  }
}
