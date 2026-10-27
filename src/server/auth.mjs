import { config } from './config.mjs';
import { query, tx } from './db.mjs';
import { HttpError, bad, v } from './http.mjs';
import {
  hashPassword, verifyPassword, burnPasswordCheck, passwordProblem, randomToken, sha256,
  newTotpSecret, verifyTotp, encrypt, decrypt,
} from './security.mjs';
import { rateLimit, audit } from './services.mjs';

export const cookieName = () => (config.insecureCookies ? 'kl_sid' : '__Host-kl_sid');

function sessionCookie(token, maxAgeSec) {
  const parts = [
    `${cookieName()}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (!config.insecureCookies) parts.push('Secure');
  return parts.join('; ');
}
export const clearCookie = () => sessionCookie('', 0);

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    phone: u.phone,
    role: u.role,
    status: u.status,
    kycStatus: u.kyc_status,
    totpEnabled: u.totp_enabled,
    selfExcludedUntil: u.self_excluded_until,
    createdAt: u.created_at,
  };
}

/** Resolve the session cookie to a user. Sets ctx.user / ctx.session. */
export async function loadSession(ctx) {
  const token = ctx.cookies[cookieName()];
  if (!token || token.length > 100) return;
  const { rows } = await query(
    `SELECT s.id AS session_id, s.last_seen_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(mins => $2)`,
    [sha256(token), config.sessionIdleMinutes]
  );
  const row = rows[0];
  if (!row) {
    ctx.clearSession = true;
    return;
  }
  if (row.status !== 'active') {
    await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [row.session_id]);
    ctx.clearSession = true;
    return;
  }
  ctx.session = { id: row.session_id };
  ctx.user = row;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    await query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  }
}

export function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in');
  return ctx.user;
}
export function requireAdmin(ctx) {
  const u = requireUser(ctx);
  if (u.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Admin access required');
  if (config.requireAdmin2fa && !u.totp_enabled)
    throw new HttpError(403, 'ADMIN_2FA_REQUIRED', 'Enable two-factor authentication on your account to use admin tools');
  return u;
}

async function createSession(ctx, userId) {
  const token = randomToken(32);
  const ttlSec = config.sessionTtlHours * 3600;
  await query(
    `INSERT INTO sessions(user_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5))`,
    [userId, sha256(token), ctx.ip, (ctx.ua || '').slice(0, 300), ttlSec]
  );
  ctx.setCookie = sessionCookie(token, ttlSec);
}

function ageOn(dobStr, now = new Date()) {
  const dob = new Date(`${dobStr}T00:00:00Z`);
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

export async function register(ctx) {
  await rateLimit(`register:ip:${ctx.ip}`, 5, 3600);
  const b = v.obj(ctx.body);
  const email = v.email(b.email);
  const displayName = v.str(b.displayName, 'Display name', { min: 2, max: 40, pattern: /^[\p{L}\p{N} ._'-]+$/u });
  const dob = v.date(b.dateOfBirth, 'Date of birth');
  const phone = v.str(b.phone, 'Phone', { optional: true, max: 20, pattern: /^\+?[0-9 ]{9,20}$/ });
  if (b.acceptTerms !== true) throw bad('You must accept the terms and confirm you are 18 or older');
  const age = ageOn(dob);
  if (age < 18) throw bad('You must be at least 18 years old to register', 'UNDERAGE');
  if (age > 120) throw bad('Date of birth is invalid');
  const pwProblem = passwordProblem(b.password, email);
  if (pwProblem) throw bad(pwProblem, 'WEAK_PASSWORD');

  const hash = await hashPassword(b.password);
  const role = config.adminEmails.includes(email) ? 'admin' : 'user';
  const user = await tx(async (db) => {
    const exists = await db.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
    if (exists.rowCount) throw new HttpError(409, 'EMAIL_TAKEN', 'An account with that email already exists');
    const { rows } = await db.query(
      `INSERT INTO users(email, password_hash, display_name, phone, date_of_birth, role, terms_accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING *`,
      [email, hash, displayName, phone, dob, role]
    );
    await db.query('INSERT INTO wallets(user_id) VALUES ($1)', [rows[0].id]);
    await audit(db, { actorId: rows[0].id, action: 'user.register', targetType: 'user', targetId: rows[0].id, ip: ctx.ip });
    return rows[0];
  }).catch((e) => {
    if (e.code === '23505') throw new HttpError(409, 'EMAIL_TAKEN', 'An account with that email already exists');
    throw e;
  });
  await createSession(ctx, user.id);
  return { user: publicUser(user) };
}

export async function login(ctx) {
  const b = v.obj(ctx.body);
  const email = v.email(b.email);
  const password = v.str(b.password, 'Password', { max: 200, trim: false });
  await rateLimit(`login:ip:${ctx.ip}`, 30, 600);
  await rateLimit(`login:email:${email}`, 10, 900);

  const { rows } = await query('SELECT * FROM users WHERE lower(email) = $1', [email]);
  const user = rows[0];
  const invalid = new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  if (!user) {
    await burnPasswordCheck(password);
    throw invalid;
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new HttpError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes.');
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    await query(
      `UPDATE users SET failed_logins = failed_logins + 1,
         locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
       WHERE id = $1`,
      [user.id, LOCK_AFTER, LOCK_MINUTES]
    );
    await audit({ query }, { actorId: user.id, action: 'auth.login_failed', targetType: 'user', targetId: user.id, ip: ctx.ip });
    throw invalid;
  }
  if (user.status !== 'active') throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is not active. Contact support.');

  if (user.totp_enabled) {
    if (!b.code) throw new HttpError(401, 'MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app');
    const step = verifyTotp(decrypt(user.totp_secret), String(b.code).trim(), user.totp_last_step);
    if (step === null) {
      await query(
        `UPDATE users SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
         WHERE id = $1`,
        [user.id, LOCK_AFTER, LOCK_MINUTES]
      );
      throw new HttpError(401, 'MFA_INVALID', 'That code is not valid');
    }
    await query('UPDATE users SET totp_last_step = $2 WHERE id = $1', [user.id, step]);
  }
  await query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
  // Re-sync admin role from ADMIN_EMAILS (promotion only).
  if (user.role !== 'admin' && config.adminEmails.includes(email)) {
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
    user.role = 'admin';
  }
  await createSession(ctx, user.id);
  await audit({ query }, { actorId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, ip: ctx.ip });
  return { user: publicUser(user) };
}

export async function logout(ctx) {
  if (ctx.session) await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [ctx.session.id]);
  ctx.setCookie = clearCookie();
  return { ok: true };
}

export async function logoutAll(ctx) {
  const u = requireUser(ctx);
  await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
  ctx.setCookie = clearCookie();
  return { ok: true };
}

export async function me(ctx) {
  if (!ctx.user) return { user: null };
  return { user: publicUser(ctx.user) };
}

export async function changePassword(ctx) {
  const u = requireUser(ctx);
  const b = v.obj(ctx.body);
  await rateLimit(`pwchange:${u.id}`, 5, 900);
  const current = v.str(b.currentPassword, 'Current password', { max: 200, trim: false });
  if (!(await verifyPassword(current, u.password_hash)))
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
  const problem = passwordProblem(b.newPassword, u.email);
  if (problem) throw bad(problem, 'WEAK_PASSWORD');
  const hash = await hashPassword(b.newPassword);
  await tx(async (db) => {
    await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [u.id, hash]);
    await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [u.id, ctx.session.id]);
    await audit(db, { actorId: u.id, action: 'auth.password_changed', targetType: 'user', targetId: u.id, ip: ctx.ip });
  });
  return { ok: true };
}

export async function totpSetup(ctx) {
  const u = requireUser(ctx);
  if (u.totp_enabled) throw bad('Two-factor authentication is already enabled');
  const secret = newTotpSecret();
  await query('UPDATE users SET totp_secret = $2 WHERE id = $1', [u.id, encrypt(secret)]);
  const label = encodeURIComponent(`Kickline:${u.email}`);
  return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Kickline&digits=6&period=30` };
}

export async function totpEnable(ctx) {
  const u = requireUser(ctx);
  await rateLimit(`totp:${u.id}`, 10, 600);
  if (u.totp_enabled) throw bad('Two-factor authentication is already enabled');
  if (!u.totp_secret) throw bad('Start setup first');
  const step = verifyTotp(decrypt(u.totp_secret), String(ctx.body?.code || '').trim());
  if (step === null) throw new HttpError(400, 'MFA_INVALID', 'That code is not valid. Check your device clock and try again.');
  await tx(async (db) => {
    await db.query('UPDATE users SET totp_enabled = TRUE, totp_last_step = $2 WHERE id = $1', [u.id, step]);
    await audit(db, { actorId: u.id, action: 'auth.2fa_enabled', targetType: 'user', targetId: u.id, ip: ctx.ip });
  });
  return { ok: true };
}

export async function totpDisable(ctx) {
  const u = requireUser(ctx);
  await rateLimit(`totp:${u.id}`, 10, 600);
  const b = v.obj(ctx.body);
  if (!u.totp_enabled) throw bad('Two-factor authentication is not enabled');
  const pw = v.str(b.password, 'Password', { max: 200, trim: false });
  if (!(await verifyPassword(pw, u.password_hash))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Password is incorrect');
  const step = verifyTotp(decrypt(u.totp_secret), String(b.code || '').trim(), u.totp_last_step);
  if (step === null) throw new HttpError(400, 'MFA_INVALID', 'That code is not valid');
  await tx(async (db) => {
    await db.query('UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, totp_last_step = NULL WHERE id = $1', [u.id]);
    await audit(db, { actorId: u.id, action: 'auth.2fa_disabled', targetType: 'user', targetId: u.id, ip: ctx.ip });
  });
  return { ok: true };
}

/** Confirm a sensitive action with password (+ TOTP if enabled). */
export async function reauth(ctx, b) {
  const u = requireUser(ctx);
  await rateLimit(`reauth:${u.id}`, 20, 600);
  const pw = v.str(b.password, 'Password', { max: 200, trim: false });
  if (!(await verifyPassword(pw, u.password_hash))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Password is incorrect');
  if (u.totp_enabled) {
    const step = verifyTotp(decrypt(u.totp_secret), String(b.code || '').trim(), u.totp_last_step);
    if (step === null) throw new HttpError(401, 'MFA_INVALID', 'Enter a valid 6-digit authenticator code');
    await query('UPDATE users SET totp_last_step = $2 WHERE id = $1', [u.id, step]);
  }
}
