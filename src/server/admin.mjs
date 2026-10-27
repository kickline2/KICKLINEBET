import { config, DEFAULT_SETTINGS } from './config.mjs';
import { query, tx } from './db.mjs';
import { HttpError, bad, v } from './http.mjs';
import { requireAdmin, publicUser, reauth } from './auth.mjs';
import { audit, moveMoney, getSettings, invalidateSettings, rateLimit } from './services.mjs';
import { adminEventsQuery, betsQuery, settleMarket } from './betting.mjs';
import { paystack, paystackEnabled } from './paystack.mjs';
import { reverseWithdrawal, refreshWithdrawal } from './wallet.mjs';
import { syncOdds } from './odds.mjs';
import { randomId } from './security.mjs';

const log = (db, ctx, action, targetType, targetId, details) =>
  audit(db, { actorId: ctx.user.id, action, targetType, targetId, details, ip: ctx.ip });

export async function overview(ctx) {
  requireAdmin(ctx);
  const q = async (sql) => (await query(sql)).rows[0];
  const [users, wallets, bets, wd, dep, odds] = await Promise.all([
    q("SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today FROM users"),
    q('SELECT coalesce(sum(balance),0)::bigint AS liabilities FROM wallets'),
    q("SELECT count(*) FILTER (WHERE status='open')::int AS open, coalesce(sum(stake) FILTER (WHERE status='open'),0)::bigint AS open_stakes, coalesce(sum(potential_payout) FILTER (WHERE status='open'),0)::bigint AS open_liability, coalesce(sum(stake) FILTER (WHERE created_at > now() - interval '1 day'),0)::bigint AS stakes_today, coalesce(sum(stake - payout) FILTER (WHERE status <> 'open' AND settled_at > now() - interval '30 days'),0)::bigint AS ggr_30d FROM bets"),
    q("SELECT count(*) FILTER (WHERE status='pending')::int AS pending, coalesce(sum(amount) FILTER (WHERE status='pending'),0)::bigint AS pending_amount FROM withdrawals"),
    q("SELECT coalesce(sum(amount) FILTER (WHERE status='success' AND completed_at > now() - interval '1 day'),0)::bigint AS today FROM deposits"),
    q("SELECT value FROM settings WHERE key = 'odds_sync'"),
  ]);
  const awaiting = await q("SELECT count(*)::int AS n FROM events WHERE status = 'scheduled' AND start_time < now() - interval '2 hours'");
  return {
    users, wallets, bets, withdrawals: wd, deposits: dep, eventsAwaitingResult: awaiting.n,
    integrations: { paystack: paystackEnabled(), paystackTransfers: config.paystackTransfersEnabled, oddsApi: Boolean(config.oddsApiKey), lastOddsSync: odds?.value || null },
  };
}

// ---------- events / markets ----------
export async function listEvents(ctx) {
  requireAdmin(ctx);
  const status = v.oneOf(ctx.url.searchParams.get('status') || 'upcoming', 'status', ['upcoming', 'awaiting', 'finished', 'cancelled']);
  const q = v.str(ctx.url.searchParams.get('q'), 'q', { optional: true, max: 60 });
  return { events: await adminEventsQuery({ status, q }) };
}

function parseSelections(list) {
  if (!Array.isArray(list) || list.length < 2 || list.length > 40) throw bad('A market needs between 2 and 40 selections');
  const seen = new Set();
  return list.map((s, i) => {
    v.obj(s);
    const name = v.str(s.name, `Selection ${i + 1} name`, { max: 80 });
    if (seen.has(name.toLowerCase())) throw bad(`Duplicate selection name: ${name}`);
    seen.add(name.toLowerCase());
    return { name, odds: v.odds(s.odds, `Selection ${i + 1} odds`), sort: i };
  });
}

async function insertMarket(db, eventId, name, selections, type = 'custom') {
  const m = (await db.query('INSERT INTO markets(event_id, type, name) VALUES ($1,$2,$3) RETURNING id', [eventId, type, name])).rows[0];
  for (const s of selections)
    await db.query('INSERT INTO selections(market_id, name, odds_milli, sort_order) VALUES ($1,$2,$3,$4)', [m.id, s.name, s.odds, s.sort]);
  return m.id;
}

export async function createEvent(ctx) {
  requireAdmin(ctx);
  const b = v.obj(ctx.body);
  const sportTitle = v.str(b.sportTitle, 'Sport', { max: 60 });
  const sportKey = v.str(b.sportKey || sportTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), 'Sport key', { max: 60, pattern: /^[a-z0-9_]+$/ });
  const league = v.str(b.league, 'League', { optional: true, max: 80 });
  const homeTeam = v.str(b.homeTeam, 'Home team', { max: 80 });
  const awayTeam = v.str(b.awayTeam, 'Away team', { max: 80 });
  const start = v.datetime(b.startTime, 'Start time');
  if (start <= new Date()) throw bad('Start time must be in the future');
  const markets = Array.isArray(b.markets) ? b.markets : [];
  if (markets.length > 30) throw bad('Too many markets');
  const parsed = markets.map((m, i) => ({ name: v.str(m.name, `Market ${i + 1} name`, { max: 80 }), selections: parseSelections(m.selections) }));
  return tx(async (db) => {
    const e = (await db.query(
      `INSERT INTO events(sport_key, sport_title, league, home_team, away_team, start_time) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [sportKey, sportTitle, league, homeTeam, awayTeam, start]
    )).rows[0];
    for (const m of parsed) await insertMarket(db, e.id, m.name, m.selections, m.name === 'Match Result' ? 'h2h' : 'custom');
    await log(db, ctx, 'event.create', 'event', e.id, { homeTeam, awayTeam, startTime: start, markets: parsed.length });
    return { id: e.id };
  }).catch((e) => {
    if (e.code === '23505') throw bad('Duplicate market name on this event');
    throw e;
  });
}

export async function updateEvent(ctx) {
  requireAdmin(ctx);
  const id = v.id(ctx.params.id);
  const b = v.obj(ctx.body);
  return tx(async (db) => {
    const e = (await db.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'Event not found');
    if (e.status !== 'scheduled') throw bad('Only scheduled events can be edited');
    const start = b.startTime !== undefined ? v.datetime(b.startTime, 'Start time') : e.start_time;
    const home = b.homeTeam !== undefined ? v.str(b.homeTeam, 'Home team', { max: 80 }) : e.home_team;
    const away = b.awayTeam !== undefined ? v.str(b.awayTeam, 'Away team', { max: 80 }) : e.away_team;
    const league = b.league !== undefined ? v.str(b.league, 'League', { optional: true, max: 80 }) : e.league;
    await db.query('UPDATE events SET start_time = $2, home_team = $3, away_team = $4, league = $5, updated_at = now() WHERE id = $1', [id, start, home, away, league]);
    await log(db, ctx, 'event.update', 'event', id, { startTime: start, homeTeam: home, awayTeam: away, league });
    return { ok: true };
  });
}

export async function addMarket(ctx) {
  requireAdmin(ctx);
  const id = v.id(ctx.params.id);
  const b = v.obj(ctx.body);
  const name = v.str(b.name, 'Market name', { max: 80 });
  const selections = parseSelections(b.selections);
  return tx(async (db) => {
    const e = (await db.query('SELECT status FROM events WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'Event not found');
    if (e.status !== 'scheduled') throw bad('Event is not open');
    const mid = await insertMarket(db, id, name, selections);
    await log(db, ctx, 'market.create', 'market', mid, { eventId: id, name });
    return { id: mid };
  }).catch((e) => {
    if (e.code === '23505') throw bad('A market with that name already exists on this event');
    throw e;
  });
}

export async function updateMarket(ctx) {
  requireAdmin(ctx);
  const id = v.id(ctx.params.id);
  const status = v.oneOf(v.obj(ctx.body).status, 'status', ['open', 'suspended']);
  return tx(async (db) => {
    const m = (await db.query('SELECT status FROM markets WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!m) throw new HttpError(404, 'NOT_FOUND', 'Market not found');
    if (!['open', 'suspended'].includes(m.status)) throw bad('Market is already settled');
    await db.query('UPDATE markets SET status = $2 WHERE id = $1', [id, status]);
    await log(db, ctx, `market.${status === 'open' ? 'reopen' : 'suspend'}`, 'market', id, null);
    return { ok: true };
  });
}

export async function updateSelection(ctx) {
  requireAdmin(ctx);
  const id = v.id(ctx.params.id);
  const odds = v.odds(v.obj(ctx.body).odds);
  return tx(async (db) => {
    const s = (await db.query(
      'SELECT s.odds_milli, s.market_id, m.status FROM selections s JOIN markets m ON m.id = s.market_id WHERE s.id = $1 FOR UPDATE OF s, m',
      [id]
    )).rows[0];
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Selection not found');
    if (!['open', 'suspended'].includes(s.status)) throw bad('Market is already settled');
    await db.query('UPDATE selections SET odds_milli = $2, updated_at = now() WHERE id = $1', [id, odds]);
    // Manual price changes stop the feed overwriting this market.
    await db.query('UPDATE markets SET auto_odds = FALSE WHERE id = $1', [s.market_id]);
    await log(db, ctx, 'selection.odds', 'selection', id, { from: s.odds_milli, to: odds });
    return { ok: true };
  });
}

export async function settle(ctx) {
  requireAdmin(ctx);
  await rateLimit(`admin-settle:${ctx.user.id}`, 60, 60);
  const id = v.id(ctx.params.id);
  const b = v.obj(ctx.body);
  const voidAll = b.void === true;
  let results = {};
  if (!voidAll) {
    if (!b.results || typeof b.results !== 'object') throw bad('results are required');
    for (const [k, r] of Object.entries(b.results)) {
      v.id(k, 'selection id');
      results[k] = v.oneOf(r, 'result', ['won', 'lost', 'void']);
    }
    if (!Object.values(results).includes('won') && !Object.values(results).every((r) => r === 'void'))
      throw bad('Mark at least one selection as won, or void the market');
  }
  return tx(async (db) => {
    const m = (await db.query('SELECT m.id, e.start_time FROM markets m JOIN events e ON e.id = m.event_id WHERE m.id = $1', [id])).rows[0];
    if (!m) throw new HttpError(404, 'NOT_FOUND', 'Market not found');
    if (!voidAll && new Date(m.start_time) > new Date()) throw bad('Cannot settle a market before the event starts (void it instead)');
    return settleMarket(db, { marketId: id, results, voidAll, actorId: ctx.user.id, ip: ctx.ip });
  });
}

export async function finishEvent(ctx) {
  requireAdmin(ctx);
  const id = v.id(ctx.params.id);
  const b = v.obj(ctx.body);
  const hs = v.int(b.homeScore, 'Home score', { min: 0, max: 999 });
  const as = v.int(b.awayScore, 'Away score', { min: 0, max: 999 });
  return tx(async (db) => {
    const e = (await db.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'Event not found');
    if (e.status !== 'scheduled') throw bad('Event is not open');
    if (new Date(e.start_time) > new Date()) throw bad('Event has not started yet');
    await db.query("UPDATE events SET status = 'finished', home_score = $2, away_score = $3, updated_at = now() WHERE id = $1", [id, hs, as]);
    // Auto-settle the Match Result market when its selections follow the standard naming.
    const h2h = (await db.query("SELECT id FROM markets WHERE event_id = $1 AND type = 'h2h' AND status IN ('open','suspended')", [id])).rows[0];
    let settled = null;
    if (h2h) {
      const sels = (await db.query('SELECT id, name FROM selections WHERE market_id = $1', [h2h.id])).rows;
      const winner = hs > as ? e.home_team : as > hs ? e.away_team : 'Draw';
      const alias = { [e.home_team]: ['home', '1'], [e.away_team]: ['away', '2'], Draw: ['draw', 'x'] };
      const isWinner = (n) => n === winner || (alias[winner] || []).includes(n.toLowerCase());
      if (sels.some((s) => isWinner(s.name))) {
        const results = Object.fromEntries(sels.map((s) => [s.id, isWinner(s.name) ? 'won' : 'lost']));
        settled = await settleMarket(db, { marketId: h2h.id, results, actorId: ctx.user.id, ip: ctx.ip });
      }
    }
    await log(db, ctx, 'event.finish', 'event', id, { homeScore: hs, awayScore: as });
    return { ok: true, matchResultSettled: settled };
  });
}

export async function cancelEvent(ctx) {
  requireAdmin(ctx);
  const id = v.id(ctx.params.id);
  return tx(async (db) => {
    const e = (await db.query('SELECT status FROM events WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'Event not found');
    if (e.status === 'cancelled') throw bad('Event is already cancelled');
    const ms = (await db.query("SELECT id FROM markets WHERE event_id = $1 AND status IN ('open','suspended') ORDER BY id", [id])).rows;
    let graded = 0;
    for (const m of ms) graded += (await settleMarket(db, { marketId: m.id, results: {}, voidAll: true, actorId: ctx.user.id, ip: ctx.ip })).betsGraded;
    await db.query("UPDATE events SET status = 'cancelled', updated_at = now() WHERE id = $1", [id]);
    await log(db, ctx, 'event.cancel', 'event', id, { marketsVoided: ms.length });
    return { ok: true, marketsVoided: ms.length, betsGraded: graded };
  });
}

// ---------- bets ----------
export async function listBets(ctx) {
  requireAdmin(ctx);
  const sp = ctx.url.searchParams;
  const status = v.oneOf(sp.get('status') || null, 'status', ['open', 'settled', 'won', 'lost', 'void'], { optional: true });
  const userId = sp.get('userId') ? v.id(sp.get('userId'), 'userId') : null;
  const before = sp.get('before') ? v.id(sp.get('before'), 'before') : null;
  return { bets: await betsQuery({ status, userId, before, limit: 50 }) };
}

// ---------- users ----------
export async function listUsers(ctx) {
  requireAdmin(ctx);
  const q = v.str(ctx.url.searchParams.get('q'), 'q', { optional: true, max: 80 });
  const params = [];
  let where = '';
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
    where = 'WHERE u.email ILIKE $1 OR u.display_name ILIKE $1 OR u.phone ILIKE $1';
  }
  const { rows } = await query(
    `SELECT u.*, w.balance FROM users u LEFT JOIN wallets w ON w.user_id = u.id ${where} ORDER BY u.id DESC LIMIT 100`,
    params
  );
  return { users: rows.map((r) => ({ ...publicUser(r), balance: r.balance })) };
}

export async function getUser(ctx) {
  requireAdmin(ctx);
  const id = v.id(ctx.params.id);
  const u = (await query('SELECT u.*, w.balance FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = $1', [id])).rows[0];
  if (!u) throw new HttpError(404, 'NOT_FOUND', 'User not found');
  const [ledger, deposits, withdrawals, stats] = await Promise.all([
    query('SELECT id, amount, balance_after, kind, ref_type, ref_id, description, created_at FROM ledger_entries WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [id]),
    query('SELECT reference, amount, status, channel, created_at FROM deposits WHERE user_id = $1 ORDER BY id DESC LIMIT 20', [id]),
    query('SELECT reference, amount, status, method, created_at FROM withdrawals WHERE user_id = $1 ORDER BY id DESC LIMIT 20', [id]),
    query("SELECT count(*)::int AS bets, coalesce(sum(stake),0)::bigint AS staked, coalesce(sum(payout),0)::bigint AS paid FROM bets WHERE user_id = $1", [id]),
  ]);
  return {
    user: { ...publicUser(u), balance: u.balance, dateOfBirth: u.date_of_birth, lockedUntil: u.locked_until },
    ledger: ledger.rows, deposits: deposits.rows, withdrawals: withdrawals.rows, stats: stats.rows[0],
  };
}

export async function updateUser(ctx) {
  requireAdmin(ctx);
  const id = v.id(ctx.params.id);
  const b = v.obj(ctx.body);
  const status = v.oneOf(b.status, 'status', ['active', 'suspended', 'closed'], { optional: true });
  const kyc = v.oneOf(b.kycStatus, 'kycStatus', ['unverified', 'pending', 'verified', 'rejected'], { optional: true });
  if (id === ctx.user.id && status && status !== 'active') throw bad('You cannot suspend your own account');
  return tx(async (db) => {
    const u = (await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'User not found');
    if (status) {
      await db.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
      if (status !== 'active') await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    if (kyc) await db.query('UPDATE users SET kyc_status = $2, updated_at = now() WHERE id = $1', [id, kyc]);
    if (b.unlock === true) await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [id]);
    await log(db, ctx, 'user.update', 'user', id, { status, kycStatus: kyc, unlock: b.unlock === true });
    return { ok: true };
  });
}

export async function adjustBalance(ctx) {
  requireAdmin(ctx);
  const id = v.id(ctx.params.id);
  const b = v.obj(ctx.body);
  const direction = v.oneOf(b.direction, 'direction', ['credit', 'debit']);
  const amount = v.money(b.amount);
  const reason = v.str(b.reason, 'Reason', { min: 5, max: 200 });
  await reauth(ctx, b);
  return tx(async (db) => {
    const u = (await db.query('SELECT id FROM users WHERE id = $1', [id])).rows[0];
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'User not found');
    const ref = randomId('adj');
    const balance = await moveMoney(db, {
      userId: id, amount: direction === 'credit' ? amount : -amount, kind: 'adjustment', refType: 'adjustment', refId: ref,
      description: reason, createdBy: ctx.user.id,
    });
    await log(db, ctx, 'wallet.adjust', 'user', id, { direction, amount, reason, ref });
    return { balance };
  });
}

// ---------- withdrawals ----------
export async function listWithdrawals(ctx) {
  requireAdmin(ctx);
  const status = v.oneOf(ctx.url.searchParams.get('status') || 'pending', 'status', ['pending', 'processing', 'paid', 'rejected', 'failed']);
  const { rows } = await query(
    `SELECT w.*, u.email, u.display_name, u.kyc_status FROM withdrawals w JOIN users u ON u.id = w.user_id
      WHERE w.status = $1 ORDER BY w.id ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 100`,
    [status]
  );
  return { withdrawals: rows };
}

async function lockWithdrawal(db, id, expected) {
  const w = (await db.query('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!w) throw new HttpError(404, 'NOT_FOUND', 'Withdrawal not found');
  if (!expected.includes(w.status)) throw new HttpError(409, 'INVALID_STATE', `Withdrawal is ${w.status}`);
  return w;
}

export async function rejectWithdrawal(ctx) {
  requireAdmin(ctx);
  const id = v.id(ctx.params.id);
  const reason = v.str(v.obj(ctx.body).reason, 'Reason', { min: 3, max: 200 });
  return tx(async (db) => {
    const w = await lockWithdrawal(db, id, ['pending']);
    await reverseWithdrawal(db, w, { status: 'rejected', note: reason, actorId: ctx.user.id });
    await log(db, ctx, 'withdrawal.reject', 'withdrawal', w.reference, { reason });
    return { ok: true };
  });
}

/** Mark paid after paying out manually (bank/MoMo outside Paystack). */
export async function markWithdrawalPaid(ctx) {
  requireAdmin(ctx);
  const id = v.id(ctx.params.id);
  const b = v.obj(ctx.body);
  const note = v.str(b.note, 'Payment reference / note', { min: 3, max: 200 });
  await reauth(ctx, b);
  return tx(async (db) => {
    const w = await lockWithdrawal(db, id, ['pending']);
    await db.query("UPDATE withdrawals SET status = 'paid', note = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $1", [w.id, note, ctx.user.id]);
    await log(db, ctx, 'withdrawal.mark_paid', 'withdrawal', w.reference, { note });
    return { ok: true };
  });
}

/** Approve and pay via Paystack Transfers. */
export async function approveWithdrawal(ctx) {
  requireAdmin(ctx);
  if (!config.paystackTransfersEnabled) throw bad('Paystack transfers are disabled. Pay manually, then use "Mark paid".');
  const id = v.id(ctx.params.id);
  await reauth(ctx, v.obj(ctx.body));
  const w = await tx(async (db) => {
    const w = await lockWithdrawal(db, id, ['pending']);
    await db.query("UPDATE withdrawals SET status = 'processing', reviewed_by = $2, reviewed_at = now(), updated_at = now() WHERE id = $1", [w.id, ctx.user.id]);
    await log(db, ctx, 'withdrawal.approve', 'withdrawal', w.reference, null);
    return w;
  });
  try {
    const recipient = await paystack('POST', '/transferrecipient', {
      type: w.method, name: w.account_name, account_number: w.account_number, bank_code: w.bank_code, currency: 'GHS',
    });
    const t = await paystack('POST', '/transfer', {
      source: 'balance', amount: w.amount, recipient: recipient.recipient_code, reference: w.reference, reason: 'Kickline withdrawal',
    });
    await query('UPDATE withdrawals SET recipient_code = $2, transfer_code = $3, updated_at = now() WHERE id = $1', [w.id, recipient.recipient_code, t.transfer_code]);
    return { ok: true, status: t.status };
  } catch (e) {
    if (e.providerStatus && e.providerStatus >= 400 && e.providerStatus < 500) {
      // Definitive rejection by provider: nothing was sent, put back to pending for review.
      await tx(async (db) => {
        await lockWithdrawal(db, id, ['processing']);
        await db.query("UPDATE withdrawals SET status = 'pending', note = $2, updated_at = now() WHERE id = $1", [id, String(e.message).slice(0, 200)]);
      });
      throw e;
    }
    // Unknown outcome (timeout etc.): stays "processing"; webhook or "Refresh" resolves it.
    throw new HttpError(502, 'TRANSFER_UNCERTAIN', 'Transfer outcome unknown. It will update automatically, or use Refresh.');
  }
}

export async function refreshWithdrawalAdmin(ctx) {
  requireAdmin(ctx);
  const id = v.id(ctx.params.id);
  const w = (await query('SELECT reference FROM withdrawals WHERE id = $1', [id])).rows[0];
  if (!w) throw new HttpError(404, 'NOT_FOUND', 'Withdrawal not found');
  return refreshWithdrawal(w.reference, { source: 'admin', actorId: ctx.user.id });
}

// ---------- settings, odds, audit ----------
export async function getSettingsAdmin(ctx) {
  requireAdmin(ctx);
  return { settings: await getSettings({ fresh: true }), defaults: DEFAULT_SETTINGS };
}

export async function putSettings(ctx) {
  requireAdmin(ctx);
  const b = v.obj(ctx.body);
  const next = {};
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(k in b)) continue;
    if (typeof def === 'boolean') next[k] = v.bool(b[k], k);
    else next[k] = v.int(b[k], k, { min: 1, max: 1_000_000_000 });
  }
  const merged = { ...(await getSettings({ fresh: true })), ...next };
  if (merged.minStake > merged.maxStake) throw bad('minStake cannot exceed maxStake');
  if (merged.minDeposit > merged.maxDeposit) throw bad('minDeposit cannot exceed maxDeposit');
  if (merged.minWithdrawal > merged.maxWithdrawal) throw bad('minWithdrawal cannot exceed maxWithdrawal');
  if (merged.minOdds <= 1000) throw bad('minOdds must be above 1000 (1.00)');
  if (merged.maxLegs > 50) throw bad('maxLegs cannot exceed 50');
  await tx(async (db) => {
    const stored = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) stored[k] = merged[k];
    await db.query(
      `INSERT INTO settings(key, value) VALUES ('limits', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
      [JSON.stringify(stored)]
    );
    await log(db, ctx, 'settings.update', 'settings', 'limits', next);
  });
  invalidateSettings();
  return { settings: await getSettings({ fresh: true }) };
}

export async function oddsSync(ctx) {
  requireAdmin(ctx);
  await rateLimit(`odds-sync:${ctx.user.id}`, 5, 600);
  // Synchronous functions have a short time limit: sync what fits, stalest first.
  return syncOdds({ force: true, actorId: ctx.user.id, budgetMs: 6_000 });
}

export async function auditLog(ctx) {
  requireAdmin(ctx);
  const before = ctx.url.searchParams.get('before') ? v.id(ctx.url.searchParams.get('before'), 'before') : null;
  const { rows } = await query(
    `SELECT a.*, u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      ${before ? 'WHERE a.id < $1' : ''} ORDER BY a.id DESC LIMIT 100`,
    before ? [before] : []
  );
  return { entries: rows };
}

// ---------- dashboard ----------
/** Business dashboard: KPIs with previous-period comparison, daily series, risk and activity. */
export async function dashboard(ctx) {
  requireAdmin(ctx);
  const days = v.oneOf(ctx.url.searchParams.get('days') || '30', 'days', ['7', '30', '90']);
  const n = Number(days);
  const kpiSql = `
    SELECT
      (SELECT count(*) FROM users WHERE created_at >= $1 AND created_at < $2)::int AS new_players,
      (SELECT count(DISTINCT user_id) FROM bets WHERE created_at >= $1 AND created_at < $2)::int AS active_bettors,
      (SELECT count(*) FROM bets WHERE created_at >= $1 AND created_at < $2)::int AS bets,
      (SELECT coalesce(sum(stake),0) FROM bets WHERE created_at >= $1 AND created_at < $2)::bigint AS stakes,
      (SELECT coalesce(sum(stake),0) FROM bets WHERE status <> 'open' AND settled_at >= $1 AND settled_at < $2)::bigint AS settled_stakes,
      (SELECT coalesce(sum(payout),0) FROM bets WHERE status <> 'open' AND settled_at >= $1 AND settled_at < $2)::bigint AS payouts,
      (SELECT coalesce(sum(amount),0) FROM deposits WHERE status = 'success' AND completed_at >= $1 AND completed_at < $2)::bigint AS deposits,
      (SELECT coalesce(sum(amount),0) FROM withdrawals WHERE status = 'paid' AND updated_at >= $1 AND updated_at < $2)::bigint AS withdrawals`;
  const cur = (await query(kpiSql, [new Date(Date.now() - n * 86400_000), new Date()])).rows[0];
  const prev = (await query(kpiSql, [new Date(Date.now() - 2 * n * 86400_000), new Date(Date.now() - n * 86400_000)])).rows[0];
  for (const r of [cur, prev]) r.ggr = r.settled_stakes - r.payouts;

  const series = (await query(
    `WITH d AS (SELECT generate_series((current_date - ($1::int - 1)), current_date, interval '1 day')::date AS day)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
       (SELECT coalesce(sum(stake),0) FROM bets WHERE created_at::date = d.day)::bigint AS stakes,
       (SELECT count(*) FROM bets WHERE created_at::date = d.day)::int AS bets,
       (SELECT coalesce(sum(payout),0) FROM bets WHERE status <> 'open' AND settled_at::date = d.day)::bigint AS payouts,
       (SELECT coalesce(sum(stake - payout),0) FROM bets WHERE status <> 'open' AND settled_at::date = d.day)::bigint AS ggr,
       (SELECT coalesce(sum(amount),0) FROM deposits WHERE status = 'success' AND completed_at::date = d.day)::bigint AS deposits,
       (SELECT coalesce(sum(amount),0) FROM withdrawals WHERE status = 'paid' AND updated_at::date = d.day)::bigint AS withdrawals,
       (SELECT count(*) FROM users WHERE created_at::date = d.day)::int AS new_players
     FROM d ORDER BY d.day`,
    [n]
  )).rows;

  const [snapshot, leagues, exposure, bigBets, statusMix, feed] = await Promise.all([
    query(`SELECT (SELECT count(*) FROM users)::int AS players,
                  (SELECT coalesce(sum(balance),0) FROM wallets)::bigint AS balances,
                  (SELECT count(*) FROM bets WHERE status='open')::int AS open_bets,
                  (SELECT coalesce(sum(stake),0) FROM bets WHERE status='open')::bigint AS open_stakes,
                  (SELECT coalesce(sum(potential_payout),0) FROM bets WHERE status='open')::bigint AS open_liability,
                  (SELECT count(*) FROM withdrawals WHERE status='pending')::int AS pending_withdrawals,
                  (SELECT coalesce(sum(amount),0) FROM withdrawals WHERE status='pending')::bigint AS pending_withdrawals_amount,
                  (SELECT count(*) FROM users WHERE kyc_status='pending')::int AS kyc_pending,
                  (SELECT count(*) FROM events WHERE status='scheduled' AND start_time > now())::int AS upcoming_events,
                  (SELECT count(*) FROM events WHERE status='scheduled' AND start_time < now() - interval '2 hours')::int AS awaiting_results`),
    query(`SELECT coalesce(e.league, e.sport_title) AS league, e.sport_title AS sport,
                  count(DISTINCT b.id)::int AS bets, coalesce(sum(b.stake / bl.n),0)::bigint AS stakes
             FROM bets b
             JOIN (SELECT bet_id, count(*) AS n FROM bet_legs GROUP BY bet_id) bl ON bl.bet_id = b.id
             JOIN bet_legs l ON l.bet_id = b.id JOIN events e ON e.id = l.event_id
            WHERE b.created_at >= now() - make_interval(days => $1)
            GROUP BY 1, 2 ORDER BY stakes DESC LIMIT 8`, [n]),
    // Worst-case liability per selection from open single bets (accas spread risk, shown separately).
    query(`SELECT s.id, s.name AS selection, m.name AS market, e.home_team || ' v ' || e.away_team AS event, e.start_time,
                  count(*)::int AS bets, sum(b.stake)::bigint AS stakes, sum(b.potential_payout)::bigint AS liability
             FROM bets b JOIN bet_legs l ON l.bet_id = b.id JOIN selections s ON s.id = l.selection_id
             JOIN markets m ON m.id = l.market_id JOIN events e ON e.id = l.event_id
            WHERE b.status = 'open' AND (SELECT count(*) FROM bet_legs x WHERE x.bet_id = b.id) = 1
            GROUP BY s.id, s.name, m.name, e.home_team, e.away_team, e.start_time
            ORDER BY liability DESC LIMIT 8`),
    query(`SELECT b.id, b.user_id, u.display_name, b.stake, b.potential_payout, b.payout, b.status, b.total_odds, b.created_at,
                  (SELECT count(*) FROM bet_legs l WHERE l.bet_id = b.id)::int AS legs
             FROM bets b JOIN users u ON u.id = b.user_id
            WHERE b.created_at >= now() - make_interval(days => $1)
            ORDER BY b.stake DESC, b.id DESC LIMIT 8`, [n]),
    query(`SELECT status, count(*)::int AS n FROM bets WHERE created_at >= now() - make_interval(days => $1) GROUP BY status`, [n]),
    query("SELECT value FROM settings WHERE key = 'odds_sync'"),
  ]);
  return {
    days: n, kpis: cur, previous: prev, series: series, snapshot: snapshot.rows[0],
    topLeagues: leagues.rows, exposure: exposure.rows, bigBets: bigBets.rows,
    statusMix: Object.fromEntries(statusMix.rows.map((r) => [r.status, r.n])),
    integrations: { paystack: paystackEnabled(), paystackTransfers: config.paystackTransfersEnabled, oddsApi: Boolean(config.oddsApiKey), lastOddsSync: feed.rows[0]?.value || null },
  };
}
