import { query, tx } from './db.mjs';
import { HttpError, bad, v } from './http.mjs';
import { requireUser } from './auth.mjs';
import { rateLimit, getSettings, moveMoney, audit } from './services.mjs';

// ---------- exact odds math (BigInt, no floating point) ----------
export function combine(stake, oddsMilliList) {
  let num = 1n;
  let den = 1n;
  for (const o of oddsMilliList) {
    num *= BigInt(o);
    den *= 1000n;
  }
  const payout = (BigInt(stake) * num) / den;
  const scaled = (num * 1_000_000n) / den; // total odds * 1e6
  const totalOdds = `${scaled / 1_000_000n}.${(scaled % 1_000_000n).toString().padStart(6, '0')}`;
  return { payout, totalOdds };
}

const oddsStr = (m) => (m / 1000).toFixed(2);

function shapeEvents(rows) {
  const events = new Map();
  for (const r of rows) {
    let e = events.get(r.event_id);
    if (!e) {
      e = {
        id: r.event_id, sportKey: r.sport_key, sportTitle: r.sport_title, league: r.league,
        homeTeam: r.home_team, awayTeam: r.away_team, startTime: r.start_time, status: r.event_status,
        homeScore: r.home_score, awayScore: r.away_score, source: r.source, markets: [],
      };
      events.set(r.event_id, e);
    }
    if (!r.market_id) continue;
    let m = e.markets.find((x) => x.id === r.market_id);
    if (!m) {
      m = { id: r.market_id, name: r.market_name, type: r.market_type, status: r.market_status, autoOdds: r.auto_odds, selections: [] };
      e.markets.push(m);
    }
    if (r.selection_id)
      m.selections.push({ id: r.selection_id, name: r.selection_name, odds: oddsStr(r.odds_milli), result: r.result });
  }
  return [...events.values()];
}

const EVENT_SQL = `
  SELECT e.id AS event_id, e.sport_key, e.sport_title, e.league, e.home_team, e.away_team, e.start_time,
         e.status AS event_status, e.home_score, e.away_score, e.source,
         m.id AS market_id, m.name AS market_name, m.type AS market_type, m.status AS market_status, m.auto_odds,
         s.id AS selection_id, s.name AS selection_name, s.odds_milli, s.result
    FROM events e
    LEFT JOIN markets m ON m.event_id = e.id %MARKET_FILTER%
    LEFT JOIN selections s ON s.market_id = m.id`;

export async function listSports() {
  const { rows } = await query(
    `SELECT sport_title AS "group", sport_key AS key, coalesce(league, sport_title) AS league, count(*)::int AS events
       FROM events e
      WHERE status = 'scheduled' AND start_time > now()
        AND EXISTS (SELECT 1 FROM markets m WHERE m.event_id = e.id AND m.status IN ('open','suspended'))
      GROUP BY 1, 2, 3
      ORDER BY CASE WHEN sport_title = 'Football' THEN 0 ELSE 1 END, 1, 4 DESC, 3`
  );
  const groups = [];
  for (const r of rows) {
    let g = groups.find((x) => x.title === r.group);
    if (!g) groups.push((g = { title: r.group, events: 0, leagues: [] }));
    g.events += r.events;
    g.leagues.push({ key: r.key, league: r.league, events: r.events });
  }
  return { groups };
}

export async function listEvents(ctx) {
  const sp = ctx.url.searchParams;
  const sport = v.str(sp.get('sport'), 'sport', { optional: true, max: 80, pattern: /^[a-z0-9_]+$/ });
  const league = v.str(sp.get('league'), 'league', { optional: true, max: 120 });
  const group = v.str(sp.get('group'), 'group', { optional: true, max: 80 });
  const q = v.str(sp.get('q'), 'q', { optional: true, max: 60 });
  const params = [];
  let where = "WHERE e.status = 'scheduled' AND e.start_time > now()";
  if (sport) {
    params.push(sport);
    where += ` AND e.sport_key = $${params.length}`;
  }
  if (league) {
    params.push(league);
    where += ` AND coalesce(e.league, e.sport_title) = $${params.length}`;
  }
  if (group) {
    params.push(group);
    where += ` AND e.sport_title = $${params.length}`;
  }
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
    where += ` AND (e.home_team ILIKE $${params.length} OR e.away_team ILIKE $${params.length} OR e.league ILIKE $${params.length})`;
  }
  const sql = `${EVENT_SQL.replace('%MARKET_FILTER%', "AND m.status IN ('open','suspended')")}
    WHERE e.id IN (SELECT e.id FROM events e ${where}
                     AND EXISTS (SELECT 1 FROM markets m WHERE m.event_id = e.id AND m.status IN ('open','suspended'))
                   ORDER BY e.start_time, e.id LIMIT 300)
    ORDER BY e.start_time, e.id, m.id, s.sort_order, s.id`;
  const { rows } = await query(sql, params);
  return { events: shapeEvents(rows).filter((e) => e.markets.length) };
}

export async function getEvent(ctx) {
  const id = v.id(ctx.params.id);
  const { rows } = await query(`${EVENT_SQL.replace('%MARKET_FILTER%', '')} WHERE e.id = $1 ORDER BY m.id, s.sort_order, s.id`, [id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'Event not found');
  return { event: shapeEvents(rows)[0] };
}

export async function adminEventsQuery({ status, q }) {
  const params = [];
  let where = 'WHERE TRUE';
  if (status === 'upcoming') where += " AND e.status = 'scheduled' AND e.start_time > now()";
  else if (status === 'awaiting') where += " AND e.status = 'scheduled' AND e.start_time <= now()";
  else if (status) {
    params.push(status);
    where += ` AND e.status = $${params.length}`;
  }
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
    where += ` AND (e.home_team ILIKE $${params.length} OR e.away_team ILIKE $${params.length})`;
  }
  const order = status === 'upcoming' || status === 'awaiting' ? 'e.start_time ASC' : 'e.start_time DESC';
  const sql = `${EVENT_SQL.replace('%MARKET_FILTER%', '')}
    WHERE e.id IN (SELECT e.id FROM events e ${where} ORDER BY ${order} LIMIT 100)
    ORDER BY ${order}, e.id, m.id, s.sort_order, s.id`;
  const { rows } = await query(sql, params);
  return shapeEvents(rows);
}

// ---------- placing bets ----------
export async function placeBet(ctx) {
  const user = requireUser(ctx);
  await rateLimit(`bet:${user.id}`, 30, 60);
  const settings = await getSettings();
  const b = v.obj(ctx.body);
  const idem = v.str(b.idempotencyKey, 'idempotencyKey', { min: 16, max: 64, pattern: /^[A-Za-z0-9_-]+$/ });
  const stake = v.money(b.stake, 'Stake');
  const acceptOddsChanges = v.oneOf(b.acceptOddsChanges ?? 'none', 'acceptOddsChanges', ['none', 'higher', 'any']);
  if (!Array.isArray(b.selections) || b.selections.length === 0) throw bad('Add at least one selection');
  if (b.selections.length > settings.maxLegs) throw bad(`A bet can have at most ${settings.maxLegs} selections`);
  const legsIn = b.selections.map((s, i) => {
    v.obj(s);
    return { selectionId: v.id(s.selectionId, `selections[${i}].selectionId`), odds: v.odds(s.odds, `selections[${i}].odds`) };
  });
  if (new Set(legsIn.map((l) => l.selectionId)).size !== legsIn.length) throw bad('Duplicate selection in bet slip');

  if (!settings.bettingEnabled) throw new HttpError(503, 'BETTING_DISABLED', 'Betting is temporarily unavailable');
  if (stake < settings.minStake) throw bad(`Minimum stake is GHS ${(settings.minStake / 100).toFixed(2)}`, 'STAKE_TOO_LOW');
  if (stake > settings.maxStake) throw bad(`Maximum stake is GHS ${(settings.maxStake / 100).toFixed(2)}`, 'STAKE_TOO_HIGH');

  return tx(async (db) => {
    // Idempotent replay: same key returns the original bet, never charges twice.
    const prior = await db.query('SELECT id FROM bets WHERE user_id = $1 AND idempotency_key = $2', [user.id, idem]);
    if (prior.rowCount) return { bet: await loadBet(db, prior.rows[0].id, user.id), replayed: true };

    const u = (await db.query('SELECT status, self_excluded_until FROM users WHERE id = $1', [user.id])).rows[0];
    if (u.status !== 'active') throw new HttpError(403, 'ACCOUNT_DISABLED', 'Account is not active');
    if (u.self_excluded_until && new Date(u.self_excluded_until) > new Date())
      throw new HttpError(403, 'SELF_EXCLUDED', 'Your account is self-excluded from betting');

    // Lock the selections/markets/events so settlement or odds changes cannot interleave.
    const { rows } = await db.query(
      `SELECT s.id, s.odds_milli, s.result, s.market_id, m.status AS market_status, m.event_id,
              e.status AS event_status, e.start_time, (e.start_time > now()) AS not_started,
              e.home_team, e.away_team, m.name AS market_name, s.name AS selection_name
         FROM selections s JOIN markets m ON m.id = s.market_id JOIN events e ON e.id = m.event_id
        WHERE s.id = ANY($1::bigint[])
        ORDER BY s.id
        FOR SHARE OF s, m, e`,
      [legsIn.map((l) => l.selectionId)]
    );
    if (rows.length !== legsIn.length) throw new HttpError(409, 'SELECTION_UNAVAILABLE', 'One or more selections no longer exist');
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const events = new Set();
    const changed = [];
    for (const l of legsIn) {
      const r = byId.get(l.selectionId);
      const label = `${r.home_team} v ${r.away_team} – ${r.selection_name}`;
      if (r.event_status !== 'scheduled' || !r.not_started)
        throw new HttpError(409, 'EVENT_STARTED', `Betting has closed for ${r.home_team} v ${r.away_team}`, { selectionId: l.selectionId });
      if (r.market_status !== 'open' || r.result !== 'pending')
        throw new HttpError(409, 'MARKET_SUSPENDED', `Market is not open: ${label}`, { selectionId: l.selectionId });
      if (events.has(Number(r.event_id)))
        throw new HttpError(409, 'RELATED_SELECTIONS', 'You cannot combine two selections from the same event', { selectionId: l.selectionId });
      events.add(Number(r.event_id));
      if (r.odds_milli < settings.minOdds || r.odds_milli > settings.maxOdds)
        throw new HttpError(409, 'MARKET_SUSPENDED', `Selection unavailable: ${label}`);
      if (r.odds_milli !== l.odds) {
        const higher = r.odds_milli > l.odds;
        if (!(acceptOddsChanges === 'any' || (acceptOddsChanges === 'higher' && higher)))
          changed.push({ selectionId: l.selectionId, odds: oddsStr(r.odds_milli) });
      }
    }
    if (changed.length) throw new HttpError(409, 'ODDS_CHANGED', 'Odds have changed. Review your bet slip.', { changes: changed });

    const legs = legsIn.map((l) => byId.get(l.selectionId));
    const { payout, totalOdds } = combine(stake, legs.map((r) => r.odds_milli));
    if (payout > BigInt(settings.maxPayout))
      throw bad(`Potential payout exceeds the maximum of GHS ${(settings.maxPayout / 100).toFixed(2)}. Reduce your stake.`, 'PAYOUT_TOO_HIGH');

    const bet = await db.query(
      `INSERT INTO bets(user_id, stake, total_odds, potential_payout, idempotency_key, ip)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [user.id, stake, totalOdds, Number(payout), idem, ctx.ip]
    );
    const betId = bet.rows[0].id;
    for (const r of legs) {
      await db.query(
        'INSERT INTO bet_legs(bet_id, selection_id, market_id, event_id, odds_milli) VALUES ($1,$2,$3,$4,$5)',
        [betId, r.id, r.market_id, r.event_id, r.odds_milli]
      );
    }
    const balance = await moveMoney(db, {
      userId: user.id, amount: -stake, kind: 'bet_stake', refType: 'bet', refId: betId,
      description: legs.length === 1 ? 'Single bet' : `${legs.length}-fold accumulator`,
    });
    return { bet: await loadBet(db, betId, user.id), balance };
  });
}

async function loadBet(db, betId, userId = null) {
  const { rows } = await db.query(
    `SELECT b.*, l.id AS leg_id, l.odds_milli, l.result AS leg_result, s.name AS selection_name, m.name AS market_name,
            e.id AS event_id, e.home_team, e.away_team, e.start_time, e.home_score, e.away_score
       FROM bets b JOIN bet_legs l ON l.bet_id = b.id JOIN selections s ON s.id = l.selection_id
       JOIN markets m ON m.id = l.market_id JOIN events e ON e.id = l.event_id
      WHERE b.id = $1 ${userId ? 'AND b.user_id = $2' : ''} ORDER BY l.id`,
    userId ? [betId, userId] : [betId]
  );
  if (!rows.length) return null;
  return shapeBets(rows)[0];
}

function shapeBets(rows) {
  const map = new Map();
  for (const r of rows) {
    let b = map.get(r.id);
    if (!b) {
      b = {
        id: r.id, userId: r.user_id, stake: r.stake, totalOdds: Number(r.total_odds).toFixed(2), potentialPayout: r.potential_payout,
        payout: r.payout, status: r.status, createdAt: r.created_at, settledAt: r.settled_at, legs: [],
      };
      map.set(r.id, b);
    }
    b.legs.push({
      id: r.leg_id, eventId: r.event_id, event: `${r.home_team} v ${r.away_team}`, startTime: r.start_time,
      market: r.market_name, selection: r.selection_name, odds: oddsStr(r.odds_milli), result: r.leg_result,
      score: r.home_score !== null && r.away_score !== null ? `${r.home_score}-${r.away_score}` : null,
    });
  }
  return [...map.values()];
}

export async function betsQuery({ userId = null, status = null, before = null, limit = 30 }) {
  const params = [];
  let where = 'WHERE TRUE';
  if (userId) { params.push(userId); where += ` AND b.user_id = $${params.length}`; }
  if (status === 'settled') where += " AND b.status <> 'open'";
  else if (status) { params.push(status); where += ` AND b.status = $${params.length}`; }
  if (before) { params.push(before); where += ` AND b.id < $${params.length}`; }
  params.push(limit);
  const { rows } = await query(
    `SELECT b.*, l.id AS leg_id, l.odds_milli, l.result AS leg_result, s.name AS selection_name, m.name AS market_name,
            e.id AS event_id, e.home_team, e.away_team, e.start_time, e.home_score, e.away_score
       FROM (SELECT * FROM bets b ${where} ORDER BY b.id DESC LIMIT $${params.length}) b
       JOIN bet_legs l ON l.bet_id = b.id JOIN selections s ON s.id = l.selection_id
       JOIN markets m ON m.id = l.market_id JOIN events e ON e.id = l.event_id
      ORDER BY b.id DESC, l.id`,
    params
  );
  return shapeBets(rows);
}

export async function myBets(ctx) {
  const u = requireUser(ctx);
  const status = v.oneOf(ctx.url.searchParams.get('status') || null, 'status', ['open', 'settled', 'won', 'lost', 'void'], { optional: true });
  const before = ctx.url.searchParams.get('before') ? v.id(ctx.url.searchParams.get('before'), 'before') : null;
  return { bets: await betsQuery({ userId: u.id, status, before }) };
}

export async function myBet(ctx) {
  const u = requireUser(ctx);
  const bet = await loadBet({ query }, v.id(ctx.params.id), u.id);
  if (!bet) throw new HttpError(404, 'NOT_FOUND', 'Bet not found');
  return { bet };
}

// ---------- settlement ----------
/**
 * Settle a market. `results` maps selectionId -> 'won'|'lost'|'void'. Every
 * selection must be given a result. Then grades every open bet touching the
 * market, paying winners exactly once (ledger has a unique key per bet).
 */
export async function settleMarket(db, { marketId, results, actorId = null, ip = null, voidAll = false }) {
  const m = (await db.query('SELECT * FROM markets WHERE id = $1 FOR UPDATE', [marketId])).rows[0];
  if (!m) throw new HttpError(404, 'NOT_FOUND', 'Market not found');
  if (m.status === 'settled' || m.status === 'void') throw new HttpError(409, 'ALREADY_SETTLED', 'Market is already settled');
  const sels = (await db.query('SELECT id FROM selections WHERE market_id = $1 FOR UPDATE', [marketId])).rows;
  const resultMap = new Map();
  for (const s of sels) {
    const r = voidAll ? 'void' : results[s.id];
    if (!['won', 'lost', 'void'].includes(r)) throw bad(`Missing result for selection ${s.id}`);
    resultMap.set(Number(s.id), r);
  }
  for (const [sid, r] of resultMap) await db.query('UPDATE selections SET result = $2, updated_at = now() WHERE id = $1', [sid, r]);
  await db.query(
    'UPDATE markets SET status = $2, settled_at = now(), settled_by = $3 WHERE id = $1',
    [marketId, voidAll ? 'void' : 'settled', actorId]
  );
  await db.query(
    `UPDATE bet_legs l SET result = s.result FROM selections s
      WHERE l.selection_id = s.id AND l.market_id = $1 AND l.result = 'pending'`,
    [marketId]
  );
  const betIds = (await db.query(
    `SELECT DISTINCT b.id FROM bets b JOIN bet_legs l ON l.bet_id = b.id
      WHERE l.market_id = $1 AND b.status = 'open' ORDER BY b.id`,
    [marketId]
  )).rows.map((r) => r.id);
  let graded = 0;
  for (const id of betIds) if (await gradeBet(db, id)) graded++;
  await audit(db, {
    actorId, action: voidAll ? 'market.void' : 'market.settle', targetType: 'market', targetId: marketId,
    details: { results: Object.fromEntries(resultMap), betsGraded: graded }, ip,
  });
  return { marketId, betsAffected: betIds.length, betsGraded: graded };
}

/** Grade one bet if it can be decided. Returns true if it was settled. */
export async function gradeBet(db, betId) {
  const bet = (await db.query("SELECT * FROM bets WHERE id = $1 AND status = 'open' FOR UPDATE", [betId])).rows[0];
  if (!bet) return false;
  const legs = (await db.query('SELECT odds_milli, result FROM bet_legs WHERE bet_id = $1', [betId])).rows;
  let status;
  let payout = 0;
  if (legs.some((l) => l.result === 'lost')) status = 'lost';
  else if (legs.some((l) => l.result === 'pending')) return false;
  else if (legs.every((l) => l.result === 'void')) {
    status = 'void';
    payout = bet.stake;
  } else {
    status = 'won';
    payout = Number(combine(bet.stake, legs.filter((l) => l.result === 'won').map((l) => l.odds_milli)).payout);
  }
  await db.query('UPDATE bets SET status = $2, payout = $3, settled_at = now() WHERE id = $1', [betId, status, payout]);
  if (payout > 0) {
    await moveMoney(db, {
      userId: bet.user_id, amount: payout, kind: status === 'void' ? 'bet_refund' : 'bet_payout',
      refType: 'bet', refId: betId, description: status === 'void' ? 'Bet void – stake returned' : 'Bet won',
    });
  }
  return true;
}

export async function settleMarketTx(args) {
  return tx((db) => settleMarket(db, args));
}
