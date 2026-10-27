import pg from 'pg';
import { config } from './config.mjs';
import { MIGRATIONS } from './schema.mjs';

// BIGINT (int8) -> JS number. All amounts are bounded far below 2^53.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

let pool;
let migrated = null;

export function getPool() {
  if (!pool) {
    const url = config.databaseUrl;
    if (!url) throw new Error('Database URL not configured');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX || 3),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: local || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: true },
    });
    pool.on('error', (err) => console.error('[db] idle client error', err.message));
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = undefined;
    migrated = null;
    await p.end();
  }
}

export async function query(text, params) {
  await ensureMigrated();
  return getPool().query(text, params);
}

/**
 * Run fn inside a transaction. Retries automatically on serialization
 * failures / deadlocks so callers can rely on strict isolation.
 */
export async function tx(fn, { isolation = 'READ COMMITTED', retries = 3 } = {}) {
  await ensureMigrated();
  for (let attempt = 0; ; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await client.query("SET LOCAL statement_timeout = '15s'");
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      const retryable = err && (err.code === '40001' || err.code === '40P01');
      if (retryable && attempt < retries) {
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * (attempt + 1)));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Apply pending migrations exactly once, guarded by an advisory lock. */
export function ensureMigrated() {
  if (!migrated) {
    migrated = runMigrations().catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

async function runMigrations() {
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [m.version]);
        await client.query('COMMIT');
        console.log(`[db] applied migration ${m.version}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(727274001)');
    } catch {
      /* ignore */
    }
    client.release();
  }
}
