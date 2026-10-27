import { query } from './db.mjs';
import { DEFAULT_SETTINGS } from './config.mjs';
import { HttpError } from './http.mjs';

/** Fixed-window rate limiter backed by Postgres (works across all function instances). */
export async function rateLimit(key, limit, windowSeconds) {
  const { rows } = await query(
    `INSERT INTO rate_limits(key, window_start, count) VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
     RETURNING count, window_start`,
    [key, windowSeconds]
  );
  if (rows[0].count > limit) {
    const retry = Math.max(1, Math.ceil((new Date(rows[0].window_start).getTime() + windowSeconds * 1000 - Date.now()) / 1000));
    throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please slow down and try again shortly.', { retryAfter: retry });
  }
}

export async function audit(db, { actorId = null, action, targetType = null, targetId = null, details = null, ip = null }) {
  await db.query(
    'INSERT INTO audit_log(actor_id, action, target_type, target_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [actorId, action, targetType, targetId === null ? null : String(targetId), details ? JSON.stringify(details) : null, ip]
  );
}

let settingsCache = null;
let settingsAt = 0;
export async function getSettings({ fresh = false } = {}) {
  if (!fresh && settingsCache && Date.now() - settingsAt < 15_000) return settingsCache;
  const { rows } = await query("SELECT value FROM settings WHERE key = 'limits'");
  settingsCache = { ...DEFAULT_SETTINGS, ...(rows[0]?.value || {}) };
  settingsAt = Date.now();
  return settingsCache;
}
export function invalidateSettings() {
  settingsCache = null;
}

/** Credit or debit a wallet atomically and write the ledger row. Must run inside tx. */
export async function moveMoney(db, { userId, amount, kind, refType, refId, description = null, createdBy = null }) {
  if (!Number.isSafeInteger(amount) || amount === 0) throw new Error('invalid amount');
  const upd = await db.query(
    `UPDATE wallets SET balance = balance + $2, updated_at = now()
     WHERE user_id = $1 AND balance + $2 >= 0 RETURNING balance`,
    [userId, amount]
  );
  if (upd.rowCount === 0) throw new HttpError(409, 'INSUFFICIENT_FUNDS', 'Insufficient balance');
  const balanceAfter = upd.rows[0].balance;
  await db.query(
    `INSERT INTO ledger_entries(user_id, amount, balance_after, kind, ref_type, ref_id, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [userId, amount, balanceAfter, kind, refType, String(refId), description, createdBy]
  );
  return balanceAfter;
}

/** Periodic housekeeping: prune stale rate-limit rows, sessions and abandoned deposits. */
export async function maintenance() {
  await query("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'");
  await query("DELETE FROM sessions WHERE (expires_at < now() - interval '30 days') OR (revoked_at < now() - interval '30 days')");
  await query("UPDATE deposits SET status = 'abandoned', completed_at = now() WHERE status = 'pending' AND created_at < now() - interval '2 days'");
}
