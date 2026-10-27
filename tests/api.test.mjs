import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  Client, resetDb, closePool, query, newUser, newAdmin, createEvent, fund, idem, ledgerConsistent, PASSWORD, totp,
} from './helpers.mjs';

let admin;
before(async () => {
  await resetDb();
  admin = await newAdmin();
});
after(async () => {
  await closePool();
});

test('registration validation', async () => {
  const c = new Client();
  const base = { email: 'kid@x.test', password: PASSWORD, displayName: 'Kid', dateOfBirth: '2015-01-01', acceptTerms: true };
  let r = await c.post('/api/auth/register', base);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'UNDERAGE');
  r = await c.post('/api/auth/register', { ...base, dateOfBirth: '1990-01-01', password: 'password1' });
  assert.equal(r.body.error.code, 'WEAK_PASSWORD');
  r = await c.post('/api/auth/register', { ...base, dateOfBirth: '1990-01-01', acceptTerms: false });
  assert.equal(r.status, 400);
  r = await c.post('/api/auth/register', { ...base, dateOfBirth: '1990-01-01' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'user');
  assert.equal(r.body.user.password_hash, undefined);
  r = await new Client().post('/api/auth/register', { ...base, email: 'KID@x.test', dateOfBirth: '1990-01-01' });
  assert.equal(r.body.error.code, 'EMAIL_TAKEN');
});

test('session cookie is HttpOnly/Secure/SameSite and logout revokes it', async () => {
  const c = new Client();
  const r = await c.req('POST', '/api/auth/register', { email: 'cookie@x.test', password: PASSWORD, displayName: 'Cookie', dateOfBirth: '1990-01-01', acceptTerms: true });
  const sc = r.headers.getSetCookie()[0];
  assert.match(sc, /^__Host-kl_sid=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Strict/);
  const stolen = c.cookie;
  assert.equal((await c.get('/api/auth/me')).body.user.email, 'cookie@x.test');
  await c.post('/api/auth/logout');
  const thief = new Client();
  thief.cookie = stolen;
  assert.equal((await thief.get('/api/auth/me')).body.user, null);
});

test('CSRF protections on state-changing requests', async () => {
  const c = new Client();
  let r = await c.req('POST', '/api/auth/login', { email: 'a@b.test', password: 'x' }, { headers: { 'x-requested-with': '' } });
  assert.equal(r.status, 403);
  r = await c.req('POST', '/api/auth/login', { email: 'a@b.test', password: 'x' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(r.body.error.code, 'BAD_ORIGIN');
});

test('login lockout after repeated failures, no user enumeration', async () => {
  await newUser('lock@x.test');
  const c = new Client();
  const unknown = await c.post('/api/auth/login', { email: 'nobody@x.test', password: 'wrong-password' });
  const wrong = await c.post('/api/auth/login', { email: 'lock@x.test', password: 'wrong-password' });
  assert.deepEqual(unknown.body, wrong.body);
  for (let i = 0; i < 4; i++) await c.post('/api/auth/login', { email: 'lock@x.test', password: 'wrong-password' });
  const locked = await c.post('/api/auth/login', { email: 'lock@x.test', password: PASSWORD });
  assert.equal(locked.status, 423);
});

test('admin endpoints require admin role and 2FA', async () => {
  const u = await newUser('nonadmin@x.test');
  assert.equal((await u.get('/api/admin/overview')).status, 403);
  const a2 = new Client();
  await query("INSERT INTO users(email,password_hash,display_name,date_of_birth,role,terms_accepted_at) SELECT 'a2@x.test', password_hash, 'a2', '1990-01-01', 'admin', now() FROM users WHERE email='admin@kickline.test'");
  await query("INSERT INTO wallets(user_id) SELECT id FROM users WHERE email='a2@x.test'");
  await a2.post('/api/auth/login', { email: 'a2@x.test', password: PASSWORD });
  const r = await a2.get('/api/admin/overview');
  assert.equal(r.body.error.code, 'ADMIN_2FA_REQUIRED');
  // login for 2FA user requires code
  const lc = new Client();
  const nocode = await lc.post('/api/auth/login', { email: 'admin@kickline.test', password: PASSWORD });
  assert.equal(nocode.body.error.code, 'MFA_REQUIRED');
  const ok = await lc.post('/api/auth/login', { email: 'admin@kickline.test', password: PASSWORD, code: await admin.code() });
  assert.equal(ok.status, 200);
  assert.equal((await admin.get('/api/admin/overview')).status, 200);
});

test('bet placement, odds protection, idempotency and settlement', async () => {
  const u = await newUser('bettor@x.test');
  await fund(admin, u.user.id, '100.00');
  const ev = await createEvent(admin);
  const [home, draw] = ev.markets[0].selections;

  // Wrong odds -> rejected with the current price
  let r = await u.post('/api/bets', { idempotencyKey: idem(), stake: '10.00', selections: [{ selectionId: home.id, odds: '2.50' }] });
  assert.equal(r.body.error.code, 'ODDS_CHANGED');
  assert.equal(r.body.error.changes[0].odds, '2.10');

  const key = idem();
  r = await u.post('/api/bets', { idempotencyKey: key, stake: '10.00', selections: [{ selectionId: home.id, odds: '2.10' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.balance, 9000);
  assert.equal(r.body.bet.potentialPayout, 2100);
  const betId = r.body.bet.id;
  // Replay of the same request never double-charges
  r = await u.post('/api/bets', { idempotencyKey: key, stake: '10.00', selections: [{ selectionId: home.id, odds: '2.10' }] });
  assert.equal(r.body.replayed, true);
  assert.equal((await u.get('/api/wallet')).body.balance, 9000);

  // Two selections from the same event cannot be combined
  r = await u.post('/api/bets', { idempotencyKey: idem(), stake: '1.00', selections: [{ selectionId: home.id, odds: '2.10' }, { selectionId: draw.id, odds: '3.20' }] });
  assert.equal(r.body.error.code, 'RELATED_SELECTIONS');

  // Cannot settle before start
  const mid = ev.markets[0].id;
  r = await admin.post(`/api/admin/markets/${mid}/settle`, { results: { [home.id]: 'won', [draw.id]: 'lost', [ev.markets[0].selections[2].id]: 'lost' } });
  assert.equal(r.status, 400);

  await query("UPDATE events SET start_time = now() - interval '1 minute' WHERE id = $1", [ev.id]);
  // Bets after kick-off are refused
  r = await u.post('/api/bets', { idempotencyKey: idem(), stake: '1.00', selections: [{ selectionId: home.id, odds: '2.10' }] });
  assert.equal(r.body.error.code, 'EVENT_STARTED');

  r = await admin.post(`/api/admin/events/${ev.id}/finish`, { homeScore: 2, awayScore: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.matchResultSettled.betsGraded, 1);
  const bet = (await u.get(`/api/bets/${betId}`)).body.bet;
  assert.equal(bet.status, 'won');
  assert.equal(bet.payout, 2100);
  assert.equal((await u.get('/api/wallet')).body.balance, 9000 + 2100);
  // Settling again is refused, so no double payout
  r = await admin.post(`/api/admin/markets/${mid}/settle`, { void: true });
  assert.equal(r.body.error.code, 'ALREADY_SETTLED');
  assert.ok(await ledgerConsistent());
});

test('accumulator: void leg reduces odds; a lost leg loses the bet', async () => {
  const u = await newUser('acca@x.test');
  await fund(admin, u.user.id, '50.00');
  const e1 = await createEvent(admin, { home: 'A1', away: 'B1', odds: ['2.00', '3.00', '4.00'] });
  const e2 = await createEvent(admin, { home: 'A2', away: 'B2', odds: ['1.50', '3.00', '5.00'] });
  const e3 = await createEvent(admin, { home: 'A3', away: 'B3', odds: ['1.333', '3.00', '5.00'] });
  let r = await u.post('/api/bets', { idempotencyKey: idem(), stake: '10.00', selections: [
    { selectionId: e1.markets[0].selections[0].id, odds: '2.00' },
    { selectionId: e2.markets[0].selections[0].id, odds: '1.50' },
    { selectionId: e3.markets[0].selections[0].id, odds: '1.333' },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.bet.potentialPayout, 3999); // 10 * 2 * 1.5 * 1.333 = 39.99 (exact integer math)
  const acc = r.body.bet.id;
  r = await u.post('/api/bets', { idempotencyKey: idem(), stake: '5.00', selections: [
    { selectionId: e1.markets[0].selections[0].id, odds: '2.00' },
    { selectionId: e2.markets[0].selections[2].id, odds: '5.00' },
  ] });
  const loser = r.body.bet.id;

  await query("UPDATE events SET start_time = now() - interval '1 minute'");
  const settleWith = (ev, idx, res = 'won') => admin.post(`/api/admin/markets/${ev.markets[0].id}/settle`, {
    results: Object.fromEntries(ev.markets[0].selections.map((s, i) => [s.id, i === idx ? res : 'lost'])),
  });
  assert.equal((await settleWith(e2, 0)).status, 200); // e2 home won => loser bet lost now
  assert.equal((await u.get(`/api/bets/${loser}`)).body.bet.status, 'lost');
  assert.equal((await u.get(`/api/bets/${acc}`)).body.bet.status, 'open');
  assert.equal((await admin.post(`/api/admin/markets/${e1.markets[0].id}/settle`, { void: true })).status, 200);
  assert.equal((await settleWith(e3, 0)).status, 200);
  const b = (await u.get(`/api/bets/${acc}`)).body.bet;
  assert.equal(b.status, 'won');
  assert.equal(b.payout, 1999); // 10 * 1.5 * 1.333 = 19.995 -> floored
  assert.ok(await ledgerConsistent());
});

test('concurrent bets cannot overspend the wallet', async () => {
  const u = await newUser('race@x.test');
  await fund(admin, u.user.id, '30.00');
  const ev = await createEvent(admin, { home: 'R1', away: 'R2' });
  const s = ev.markets[0].selections[0];
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    u.post('/api/bets', { idempotencyKey: idem(), stake: '10.00', selections: [{ selectionId: s.id, odds: s.odds }] })));
  const ok = results.filter((r) => r.status === 200).length;
  const insufficient = results.filter((r) => r.body?.error?.code === 'INSUFFICIENT_FUNDS').length;
  assert.equal(ok, 3);
  assert.equal(insufficient, 9);
  assert.equal((await u.get('/api/wallet')).body.balance, 0);
  assert.ok(await ledgerConsistent());
});

test('suspended markets and stake limits are enforced', async () => {
  const u = await newUser('limits@x.test');
  await fund(admin, u.user.id, '20.00');
  const ev = await createEvent(admin, { home: 'S1', away: 'S2' });
  const s = ev.markets[0].selections[0];
  let r = await u.post('/api/bets', { idempotencyKey: idem(), stake: '0.50', selections: [{ selectionId: s.id, odds: s.odds }] });
  assert.equal(r.body.error.code, 'STAKE_TOO_LOW');
  await admin.patch(`/api/admin/markets/${ev.markets[0].id}`, { status: 'suspended' });
  r = await u.post('/api/bets', { idempotencyKey: idem(), stake: '1.00', selections: [{ selectionId: s.id, odds: s.odds }] });
  assert.equal(r.body.error.code, 'MARKET_SUSPENDED');
  // Odds change by admin
  await admin.patch(`/api/admin/markets/${ev.markets[0].id}`, { status: 'open' });
  await admin.patch(`/api/admin/selections/${s.id}`, { odds: '2.40' });
  r = await u.post('/api/bets', { idempotencyKey: idem(), stake: '1.00', acceptOddsChanges: 'higher', selections: [{ selectionId: s.id, odds: s.odds }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.bet.legs[0].odds, '2.40');
});

test('responsible gambling: self-exclusion and limit cooling-off', async () => {
  const u = await newUser('rg@x.test');
  await fund(admin, u.user.id, '20.00');
  let r = await u.put('/api/account/limits', { daily: '50.00' });
  assert.equal(r.body.limits.daily.amount, 5000);
  r = await u.put('/api/account/limits', { daily: '500.00' });
  assert.equal(r.body.limits.daily.amount, 5000, 'increase must not apply immediately');
  assert.equal(r.body.limits.daily.pending.amount, 50000);
  r = await u.put('/api/account/limits', { daily: '20.00' });
  assert.equal(r.body.limits.daily.amount, 2000, 'decrease applies immediately');
  r = await u.post('/api/account/self-exclude', { period: '7d', password: PASSWORD });
  assert.equal(r.status, 200);
  const ev = await createEvent(admin, { home: 'X1', away: 'X2' });
  const s = ev.markets[0].selections[0];
  r = await u.post('/api/bets', { idempotencyKey: idem(), stake: '1.00', selections: [{ selectionId: s.id, odds: s.odds }] });
  assert.equal(r.body.error.code, 'SELF_EXCLUDED');
});

test('withdrawals: KYC, re-auth, hold and refund on rejection', async () => {
  const u = await newUser('wd@x.test');
  await fund(admin, u.user.id, '100.00');
  const body = { amount: '40.00', method: 'mobile_money', bankCode: 'MTN', accountNumber: '0241234567', accountName: 'Kofi Mensah', password: PASSWORD };
  let r = await u.post('/api/wallet/withdrawals', body);
  assert.equal(r.body.error.code, 'KYC_REQUIRED');
  await admin.patch(`/api/admin/users/${u.user.id}`, { kycStatus: 'verified' });
  r = await u.post('/api/wallet/withdrawals', { ...body, password: 'wrong-password!' });
  assert.equal(r.status, 401);
  r = await u.post('/api/wallet/withdrawals', body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.balance, 6000);
  r = await u.post('/api/wallet/withdrawals', { ...body, amount: '70.00' });
  assert.equal(r.body.error.code, 'INSUFFICIENT_FUNDS');
  const list = (await admin.get('/api/admin/withdrawals?status=pending')).body.withdrawals;
  const w = list.find((x) => x.user_id === u.user.id);
  r = await admin.post(`/api/admin/withdrawals/${w.id}/reject`, { reason: 'Name mismatch' });
  assert.equal(r.status, 200);
  assert.equal((await u.get('/api/wallet')).body.balance, 10000);
  r = await admin.post(`/api/admin/withdrawals/${w.id}/reject`, { reason: 'again' });
  assert.equal(r.status, 409);
  assert.ok(await ledgerConsistent());
});

test('Paystack: signed webhook credits a deposit exactly once; bad signatures rejected', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_dummy_secret';
  const realFetch = globalThis.fetch;
  const verified = {};
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/transaction/initialize')) {
      const b = JSON.parse(opts.body);
      verified[b.reference] = { status: 'success', amount: b.amount, currency: 'GHS', reference: b.reference, channel: 'mobile_money', id: 1 };
      return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/abc', reference: b.reference } });
    }
    const m = u.match(/\/transaction\/verify\/(.+)$/);
    if (m) return Response.json({ status: true, data: verified[decodeURIComponent(m[1])] });
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const u = await newUser('pay@x.test');
    let r = await u.post('/api/wallet/deposits', { amount: '25.00' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ref = r.body.reference;
    const evt = JSON.stringify({ event: 'charge.success', data: { reference: ref, id: 1, status: 'success', amount: 2500 } });
    const sig = crypto.createHmac('sha512', 'sk_test_dummy_secret').update(evt).digest('hex');
    const hook = new Client();
    r = await hook.req('POST', '/api/webhooks/paystack', undefined, { raw: evt, headers: { 'x-paystack-signature': 'bad', 'x-requested-with': '', origin: '' } });
    assert.equal(r.status, 401);
    assert.equal((await u.get('/api/wallet')).body.balance, 0);
    for (let i = 0; i < 3; i++) {
      r = await hook.req('POST', '/api/webhooks/paystack', undefined, { raw: evt, headers: { 'x-paystack-signature': sig, 'content-type': 'application/json', 'x-requested-with': '', origin: '' } });
      assert.equal(r.status, 200);
    }
    r = await u.post(`/api/wallet/deposits/${ref}/check`);
    assert.equal(r.body.status, 'success');
    assert.equal((await u.get('/api/wallet')).body.balance, 2500);

    // Tampered amount reported by provider is never credited
    r = await u.post('/api/wallet/deposits', { amount: '30.00' });
    verified[r.body.reference].amount = 300000;
    r = await u.post(`/api/wallet/deposits/${r.body.reference}/check`);
    assert.equal(r.body.status, 'failed');
    assert.equal((await u.get('/api/wallet')).body.balance, 2500);

    // Deposit limit enforcement
    await u.put('/api/account/limits', { daily: '40.00' });
    r = await u.post('/api/wallet/deposits', { amount: '20.00' });
    assert.equal(r.body.error.code, 'DEPOSIT_LIMIT');
    assert.ok(await ledgerConsistent());
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.PAYSTACK_SECRET_KEY;
  }
});

test('cancelling an event refunds open bets', async () => {
  const u = await newUser('cancel@x.test');
  await fund(admin, u.user.id, '10.00');
  const ev = await createEvent(admin, { home: 'C1', away: 'C2' });
  const s = ev.markets[0].selections[1];
  await u.post('/api/bets', { idempotencyKey: idem(), stake: '10.00', selections: [{ selectionId: s.id, odds: s.odds }] });
  assert.equal((await u.get('/api/wallet')).body.balance, 0);
  const r = await admin.post(`/api/admin/events/${ev.id}/cancel`);
  assert.equal(r.status, 200);
  assert.equal((await u.get('/api/wallet')).body.balance, 1000);
  assert.ok(await ledgerConsistent());
});

test('users cannot read other users\' bets; errors do not leak internals', async () => {
  const a = await newUser('alice@x.test');
  const b = await newUser('bob@x.test');
  await fund(admin, a.user.id, '5.00');
  const ev = await createEvent(admin, { home: 'P1', away: 'P2' });
  const s = ev.markets[0].selections[0];
  const r = await a.post('/api/bets', { idempotencyKey: idem(), stake: '1.00', selections: [{ selectionId: s.id, odds: s.odds }] });
  assert.equal((await b.get(`/api/bets/${r.body.bet.id}`)).status, 404);
  const bad = await a.req('POST', '/api/bets', undefined, { raw: '{"bad json', headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
  assert.equal((await b.get('/api/admin/users')).status, 403);
  assert.equal((await new Client().get('/api/wallet')).status, 401);
});

test('admin balance adjustments require password + 2FA and are audited', async () => {
  const u = await newUser('adj@x.test');
  let r = await admin.post(`/api/admin/users/${u.user.id}/adjust`, { direction: 'credit', amount: '5.00', reason: 'Goodwill credit', password: PASSWORD });
  assert.equal(r.body.error.code, 'MFA_INVALID');
  r = await admin.post(`/api/admin/users/${u.user.id}/adjust`, { direction: 'credit', amount: '5.00', reason: 'Goodwill credit', password: PASSWORD, code: await totp(admin.user.id, admin.secret) });
  assert.equal(r.status, 200);
  const log = (await admin.get('/api/admin/audit')).body.entries;
  assert.ok(log.some((e) => e.action === 'wallet.adjust' && e.target_id === String(u.user.id)));
});

test('odds feed import applies margin, respects manual overrides, and auto-settles from scores', async () => {
  process.env.ODDS_API_KEY = 'test-key';
  process.env.ODDS_API_SPORTS = 'soccer_epl';
  const realFetch = globalThis.fetch;
  const start = new Date(Date.now() + 7200_000).toISOString();
  let completed = false;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    assert.equal(u.searchParams.get('apiKey'), 'test-key');
    if (u.pathname.endsWith('/odds')) {
      return Response.json([{ id: 'evt1', sport_title: 'EPL', commence_time: start, home_team: 'Arsenal', away_team: 'Chelsea', bookmakers: [
        { markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2.0 }, { name: 'Chelsea', price: 3.6 }, { name: 'Draw', price: 3.4 }] }] },
        { markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2.2 }, { name: 'Chelsea', price: 3.4 }, { name: 'Draw', price: 3.3 }] }] },
      ] }]);
    }
    if (u.pathname.endsWith('/scores')) {
      return Response.json(completed ? [{ id: 'evt1', completed: true, home_team: 'Arsenal', away_team: 'Chelsea', scores: [{ name: 'Arsenal', score: '0' }, { name: 'Chelsea', score: '1' }] }] : []);
    }
    throw new Error('unexpected');
  };
  try {
    let r = await admin.post('/api/admin/odds/sync');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.sports.soccer_epl.upserted, 1);
    const ev = (await admin.get('/api/events?q=Arsenal')).body.events[0];
    const sel = Object.fromEntries(ev.markets[0].selections.map((s) => [s.name, s]));
    assert.equal(sel.Arsenal.odds, '1.99'); // median 2.10 * 0.95 = 1.995 -> 1.99
    assert.deepEqual(ev.markets[0].selections.map((s) => s.name), ['Arsenal', 'Draw', 'Chelsea']);
    const u = await newUser('feed@x.test');
    await fund(admin, u.user.id, '10.00');
    r = await u.post('/api/bets', { idempotencyKey: idem(), stake: '10.00', selections: [{ selectionId: sel.Chelsea.id, odds: sel.Chelsea.odds }] });
    assert.equal(r.status, 200);
    await query("UPDATE events SET start_time = now() - interval '2 hours' WHERE external_id = 'oddsapi:evt1'");
    completed = true;
    r = await admin.post('/api/admin/odds/sync');
    assert.equal(r.body.sports.soccer_epl.settled, 1);
    const w = (await u.get('/api/wallet')).body.balance;
    assert.equal(w, Math.floor(1000 * Number(sel.Chelsea.odds)));
    assert.ok(await ledgerConsistent());
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ODDS_API_KEY;
  }
});
