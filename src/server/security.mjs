import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.mjs';

const scrypt = promisify(crypto.scrypt);

// ---------- Passwords (scrypt, memory-hard, built into Node) ----------
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 };
const SCRYPT_MAXMEM = 128 * SCRYPT.N * SCRYPT.r * 2;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(N) * Number(r) * 2,
    });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// A fixed dummy hash, so login timing does not reveal whether an email exists.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}

const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyuiop',
  'iloveyou', 'football', 'letmein123', 'welcome123', 'admin12345', 'passw0rd', 'qwerty123',
  'abc12345', 'baseball', 'sunshine1', 'princess1', 'superman1', 'trustno1', 'changeme',
]);
export function passwordProblem(pw, email = '') {
  if (typeof pw !== 'string') return 'Password is required';
  if (pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 128) return 'Password must be at most 128 characters';
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common';
  if (email && lower.includes(email.toLowerCase().split('@')[0]) && email.split('@')[0].length >= 4)
    return 'Password must not contain your email name';
  if (new Set(pw).size < 5) return 'Password is too repetitive';
  return null;
}

// ---------- Tokens ----------
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------- Symmetric encryption for secrets at rest (AES-256-GCM) ----------
function encKey() {
  const secret = config.appSecret;
  if (!secret || secret.length < 32) throw new Error('APP_SECRET is not configured (min 32 chars)');
  return crypto.createHash('sha256').update(`kickline-enc:${secret}`).digest();
}
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}
export function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split('.');
  if (v !== 'v1') throw new Error('bad ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

// ---------- TOTP (RFC 6238) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function totpAt(secretB32, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}

/** Returns the matched time step, or null. Allows +/- 1 step of clock drift. */
export function verifyTotp(secretB32, code, lastStep = null, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const cur = Math.floor(now / 30000);
  for (const s of [cur, cur - 1, cur + 1]) {
    if (lastStep !== null && s <= Number(lastStep)) continue; // replay protection
    if (safeEqual(totpAt(secretB32, s), code)) return s;
  }
  return null;
}
