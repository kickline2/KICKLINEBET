import { handle } from '../src/server/app.mjs';
import { query, closePool, ensureMigrated, getPool } from '../src/server/db.mjs';
import { totpAt } from '../src/server/security.mjs';

process.env.DATABASE_URL ||= 'postgres://kick:kick@localhost:5432/kickline_test';
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-1234';
process.env.SITE_URL = 'http://localhost:8888';
process.env.ADMIN_EMAILS = 'admin@kickline.test';
process.env.LOG_REQUESTS = '0';

export async function resetDb() {
  await ensureMigrated();
  await getPool().query(`TRUNCATE users, sessions, wallets, ledger_entries, deposits, withdrawals, events, markets, selections,
    bets, bet_legs, deposit_limits, rate_limits, audit_log, settings, webhook_events RESTART IDENTITY CASCADE`);
  const { invalidateSettings } = await import('../src/server/services.mjs');
  invalidateSettings();
}
export { query, closePool, totpAt };

let ipCounter = 1;
export class Client {
  constructor() {
    this.cookie = '';
    this.ip = `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`;
  }
  async req(method, path, body, { headers = {}, raw } = {}) {
    const h = new Headers({ origin: 'http://localhost:8888', 'x-requested-with': 'kickline', ...headers });
    if (this.cookie) h.set('cookie', this.cookie);
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      h.set('content-type', 'application/json');
    }
    const res = await handle(new Request(`http://localhost:8888${path}`, { method, headers: h, body: payload }), { ip: this.ip });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  patch(p, b = {}) { return this.req('PATCH', p, b); }
}

export const PASSWORD = 'Correct-Horse-9-Battery';

export async function newUser(email, extra = {}) {
  const c = new Client();
  const r = await c.post('/api/auth/register', {
    email, password: PASSWORD, displayName: email.split('@')[0], dateOfBirth: '1995-05-05', acceptTerms: true, ...extra,
  });
  if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  c.user = r.body.user;
  return c;
}

/** Current valid TOTP code, clearing replay state so tests can reuse steps. */
export async function totp(userId, secret) {
  await query('UPDATE users SET totp_last_step = NULL WHERE id = $1', [userId]);
  return totpAt(secret, Math.floor(Date.now() / 30000));
}

export async function newAdmin() {
  const c = await newUser('admin@kickline.test');
  const s = await c.post('/api/auth/2fa/setup');
  c.secret = s.body.secret;
  const r = await c.post('/api/auth/2fa/enable', { code: await totp(c.user.id, c.secret) });
  if (r.status !== 200) throw new Error('2fa enable failed');
  c.code = () => totp(c.user.id, c.secret);
  return c;
}

export async function createEvent(admin, { start = new Date(Date.now() + 3600_000), home = 'Hearts of Oak', away = 'Asante Kotoko', odds = ['2.10', '3.20', '3.50'] } = {}) {
  const r = await admin.post('/api/admin/events', {
    sportTitle: 'Football', league: 'Ghana Premier League', homeTeam: home, awayTeam: away, startTime: start.toISOString(),
    markets: [{ name: 'Match Result', selections: [{ name: home, odds: odds[0] }, { name: 'Draw', odds: odds[1] }, { name: away, odds: odds[2] }] }],
  });
  if (r.status !== 200) throw new Error(`create event failed ${JSON.stringify(r.body)}`);
  const ev = (await admin.get(`/api/events/${r.body.id}`)).body.event;
  return ev;
}

export async function fund(admin, userId, amount) {
  await query("DELETE FROM rate_limits WHERE key LIKE 'reauth:%'");
  const r = await admin.post(`/api/admin/users/${userId}/adjust`, { direction: 'credit', amount, reason: 'Test funding', password: PASSWORD, code: await admin.code() });
  if (r.status !== 200) throw new Error(`fund failed ${JSON.stringify(r.body)}`);
}

export const idem = () => `k${Math.random().toString(36).slice(2)}${Date.now().toString(36)}xxxxxxxx`;

export async function ledgerConsistent() {
  const { rows } = await query(`SELECT w.user_id, w.balance, coalesce(sum(l.amount),0)::bigint AS ledger
    FROM wallets w LEFT JOIN ledger_entries l ON l.user_id = w.user_id GROUP BY w.user_id, w.balance`);
  return rows.every((r) => Number(r.balance) === Number(r.ledger));
}
