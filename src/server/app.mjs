import { config, assertProductionConfig } from './config.mjs';
import { HttpError, json, parseCookies, requestId } from './http.mjs';
import * as auth from './auth.mjs';
import * as betting from './betting.mjs';
import * as wallet from './wallet.mjs';
import * as admin from './admin.mjs';
import { getSettings } from './services.mjs';
import { paystackEnabled } from './paystack.mjs';
import { ensureAppSecret } from './secrets.mjs';
import { query } from './db.mjs';

const ROUTES = [
  // public
  ['GET', '/api/health', async () => {
    await query('SELECT 1');
    return { ok: true, db: true };
  }],
  ['GET', '/api/config', publicConfig],
  ['GET', '/api/sports', betting.listSports],
  ['GET', '/api/events', betting.listEvents],
  ['GET', '/api/events/:id', betting.getEvent],
  // auth
  ['POST', '/api/auth/register', auth.register],
  ['POST', '/api/auth/login', auth.login],
  ['POST', '/api/auth/logout', auth.logout],
  ['POST', '/api/auth/logout-all', auth.logoutAll],
  ['GET', '/api/auth/me', auth.me],
  ['POST', '/api/auth/password', auth.changePassword],
  ['POST', '/api/auth/2fa/setup', auth.totpSetup],
  ['POST', '/api/auth/2fa/enable', auth.totpEnable],
  ['POST', '/api/auth/2fa/disable', auth.totpDisable],
  // betting
  ['POST', '/api/bets', betting.placeBet],
  ['GET', '/api/bets', betting.myBets],
  ['GET', '/api/bets/:id', betting.myBet],
  // wallet & responsible gambling
  ['GET', '/api/wallet', wallet.wallet],
  ['GET', '/api/wallet/transactions', wallet.transactions],
  ['GET', '/api/wallet/deposits', wallet.myDeposits],
  ['POST', '/api/wallet/deposits', wallet.startDeposit],
  ['POST', '/api/wallet/deposits/:reference/check', wallet.checkDeposit],
  ['GET', '/api/wallet/withdrawals', wallet.myWithdrawals],
  ['POST', '/api/wallet/withdrawals', wallet.requestWithdrawal],
  ['GET', '/api/wallet/banks', wallet.banks],
  ['GET', '/api/account/limits', wallet.getLimits],
  ['PUT', '/api/account/limits', wallet.setLimits],
  ['POST', '/api/account/self-exclude', wallet.selfExclude],
  // webhooks (signature-verified, exempt from CSRF/origin checks)
  ['POST', '/api/webhooks/paystack', wallet.paystackWebhook, { webhook: true }],
  // admin
  ['GET', '/api/admin/overview', admin.overview],
  ['GET', '/api/admin/events', admin.listEvents],
  ['POST', '/api/admin/events', admin.createEvent],
  ['PATCH', '/api/admin/events/:id', admin.updateEvent],
  ['POST', '/api/admin/events/:id/markets', admin.addMarket],
  ['POST', '/api/admin/events/:id/finish', admin.finishEvent],
  ['POST', '/api/admin/events/:id/cancel', admin.cancelEvent],
  ['PATCH', '/api/admin/markets/:id', admin.updateMarket],
  ['POST', '/api/admin/markets/:id/settle', admin.settle],
  ['PATCH', '/api/admin/selections/:id', admin.updateSelection],
  ['GET', '/api/admin/bets', admin.listBets],
  ['GET', '/api/admin/users', admin.listUsers],
  ['GET', '/api/admin/users/:id', admin.getUser],
  ['PATCH', '/api/admin/users/:id', admin.updateUser],
  ['POST', '/api/admin/users/:id/adjust', admin.adjustBalance],
  ['GET', '/api/admin/withdrawals', admin.listWithdrawals],
  ['POST', '/api/admin/withdrawals/:id/approve', admin.approveWithdrawal],
  ['POST', '/api/admin/withdrawals/:id/reject', admin.rejectWithdrawal],
  ['POST', '/api/admin/withdrawals/:id/mark-paid', admin.markWithdrawalPaid],
  ['POST', '/api/admin/withdrawals/:id/refresh', admin.refreshWithdrawalAdmin],
  ['GET', '/api/admin/settings', admin.getSettingsAdmin],
  ['PUT', '/api/admin/settings', admin.putSettings],
  ['POST', '/api/admin/odds/sync', admin.oddsSync],
  ['GET', '/api/admin/audit', admin.auditLog],
].map(([method, pattern, handler, opts = {}]) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([^/]+)'))}/?$`);
  return { method, re, keys, handler, ...opts };
});

async function publicConfig() {
  const s = await getSettings();
  return {
    currency: config.currency,
    payments: paystackEnabled(),
    limits: {
      minStake: s.minStake, maxStake: s.maxStake, maxPayout: s.maxPayout, maxLegs: s.maxLegs,
      minDeposit: s.minDeposit, maxDeposit: s.maxDeposit, minWithdrawal: s.minWithdrawal, maxWithdrawal: s.maxWithdrawal,
    },
    bettingEnabled: s.bettingEnabled, depositsEnabled: s.depositsEnabled, withdrawalsEnabled: s.withdrawalsEnabled,
    requireKycForWithdrawal: s.requireKycForWithdrawal,
  };
}

const MAX_BODY = 64 * 1024;

function originAllowed(req, url) {
  const origin = req.headers.get('origin');
  const allowed = new Set([url.origin, new URL(config.siteUrl).origin]);
  if (origin) return allowed.has(origin);
  const ref = req.headers.get('referer');
  if (ref) {
    try {
      return allowed.has(new URL(ref).origin);
    } catch {
      return false;
    }
  }
  return true; // non-browser clients; still need the custom header below
}

export async function handle(req, { ip = '0.0.0.0' } = {}) {
  const rid = requestId();
  const started = Date.now();
  const url = new URL(req.url);
  const ctx = { req, url, ip, ua: req.headers.get('user-agent') || '', cookies: parseCookies(req.headers.get('cookie')), params: {}, rid };
  let res;
  try {
    {
      const problems = assertProductionConfig();
      if (!(await ensureAppSecret())) problems.push('APP_SECRET missing and Netlify Blobs unavailable to generate one');
      if (problems.length) {
        console.error('[config]', problems.join('; '));
        throw new HttpError(503, 'MISCONFIGURED', 'Service is not configured', { problems: problems.map((p) => p.split(' ')[0]) });
      }
    }
    const method = req.method.toUpperCase();
    let route;
    let pathMatched = false;
    for (const r of ROUTES) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      route = r;
      r.keys.forEach((k, i) => {
        ctx.params[k] = decodeURIComponent(m[i + 1]);
      });
      break;
    }
    if (!route) throw pathMatched ? new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed') : new HttpError(404, 'NOT_FOUND', 'Not found');

    if (method !== 'GET' && method !== 'HEAD') {
      if (!route.webhook) {
        // CSRF defence: same-origin check + a custom header that cross-site forms cannot send.
        if (!originAllowed(req, url)) throw new HttpError(403, 'BAD_ORIGIN', 'Cross-site request blocked');
        if (req.headers.get('x-requested-with') !== 'kickline') throw new HttpError(403, 'CSRF', 'Missing request header');
      }
      const len = Number(req.headers.get('content-length') || 0);
      if (len > MAX_BODY) throw new HttpError(413, 'TOO_LARGE', 'Request body too large');
      const raw = await req.text();
      if (raw.length > MAX_BODY) throw new HttpError(413, 'TOO_LARGE', 'Request body too large');
      ctx.rawBody = raw;
      if (!route.webhook) {
        const ct = req.headers.get('content-type') || '';
        if (raw && !ct.includes('application/json')) throw new HttpError(415, 'UNSUPPORTED', 'Use application/json');
        try {
          ctx.body = raw ? JSON.parse(raw) : {};
        } catch {
          throw new HttpError(400, 'BAD_JSON', 'Malformed JSON');
        }
      }
    }

    if (!route.webhook) await auth.loadSession(ctx);
    const result = await route.handler(ctx);
    res = json(200, result);
  } catch (err) {
    if (err instanceof HttpError) {
      res = json(err.status, { error: { code: err.code, message: err.message, ...(err.extra || {}) } },
        err.status === 429 && err.extra?.retryAfter ? { 'retry-after': String(err.extra.retryAfter) } : {});
    } else {
      console.error(`[${rid}] unhandled`, err);
      res = json(500, { error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId: rid } });
    }
  }
  if (ctx.setCookie) res.headers.append('set-cookie', ctx.setCookie);
  else if (ctx.clearSession) res.headers.append('set-cookie', auth.clearCookie());
  res.headers.set('x-request-id', rid);
  if (process.env.LOG_REQUESTS !== '0')
    console.log(`[${rid}] ${req.method} ${url.pathname} ${res.status} ${Date.now() - started}ms`);
  return res;
}
