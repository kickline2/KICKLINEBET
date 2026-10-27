import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const bad = (msg, code = 'VALIDATION', extra) => new HttpError(400, code, msg, extra);

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

export function json(status, body, headers = {}) {
  const h = new Headers({ ...BASE_HEADERS, ...headers });
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: h });
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

export const requestId = () => crypto.randomBytes(8).toString('hex');

// --------- Tiny, strict input validation ---------
export const v = {
  obj(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad('Request body must be a JSON object');
    return x;
  },
  str(x, name, { min = 1, max = 200, pattern, optional = false, trim = true } = {}) {
    if (x === undefined || x === null || x === '') {
      if (optional) return null;
      throw bad(`${name} is required`);
    }
    if (typeof x !== 'string') throw bad(`${name} must be text`);
    const s = trim ? x.trim() : x;
    if (s.length < min) throw bad(`${name} must be at least ${min} characters`);
    if (s.length > max) throw bad(`${name} must be at most ${max} characters`);
    if (/[\u0000-\u001f\u007f]/.test(s)) throw bad(`${name} contains invalid characters`);
    if (pattern && !pattern.test(s)) throw bad(`${name} is invalid`);
    return s;
  },
  int(x, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
    if (x === undefined || x === null || x === '') {
      if (optional) return null;
      throw bad(`${name} is required`);
    }
    const n = typeof x === 'string' && /^-?\d+$/.test(x) ? Number(x) : x;
    if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw bad(`${name} must be a whole number`);
    if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}`);
    return n;
  },
  id(x, name = 'id') {
    return v.int(x, name, { min: 1 });
  },
  bool(x, name, { optional = false } = {}) {
    if (x === undefined || x === null) {
      if (optional) return null;
      throw bad(`${name} is required`);
    }
    if (typeof x !== 'boolean') throw bad(`${name} must be true or false`);
    return x;
  },
  oneOf(x, name, values, { optional = false } = {}) {
    if (x === undefined || x === null || x === '') {
      if (optional) return null;
      throw bad(`${name} is required`);
    }
    if (!values.includes(x)) throw bad(`${name} must be one of: ${values.join(', ')}`);
    return x;
  },
  email(x) {
    const s = v.str(x, 'Email', { max: 254 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw bad('Email is invalid');
    return s;
  },
  date(x, name) {
    const s = v.str(x, name, { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad(`${name} is invalid`);
    return s;
  },
  datetime(x, name) {
    const s = v.str(x, name, { max: 40 });
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw bad(`${name} is invalid`);
    return d;
  },
  /** Decimal odds string/number like "2.15" -> 2150 (thousandths). */
  odds(x, name = 'Odds') {
    const s = typeof x === 'number' ? String(x) : x;
    if (typeof s !== 'string' || !/^\d{1,4}(\.\d{1,3})?$/.test(s.trim())) throw bad(`${name} must be decimal odds like 2.15`);
    const [i, f = ''] = s.trim().split('.');
    const milli = Number(i) * 1000 + Number(f.padEnd(3, '0'));
    if (milli <= 1000) throw bad(`${name} must be greater than 1.00`);
    return milli;
  },
  /** Money in major units ("12.50" or 12.5) -> minor units (1250). */
  money(x, name = 'Amount') {
    const s = typeof x === 'number' ? x.toFixed(2) : x;
    if (typeof s !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(s.trim())) throw bad(`${name} must be an amount like 10.00`);
    const [i, f = ''] = s.trim().split('.');
    const minor = Number(i) * 100 + Number(f.padEnd(2, '0'));
    if (minor <= 0) throw bad(`${name} must be greater than zero`);
    return minor;
  },
};

export const fmtMoney = (minor) => (minor / 100).toFixed(2);
export const fmtOdds = (milli) => (milli / 1000).toFixed(2);
