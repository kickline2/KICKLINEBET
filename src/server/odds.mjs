import { config } from './config.mjs';
import { query, tx } from './db.mjs';
import { settleMarket } from './betting.mjs';
import { audit } from './services.mjs';

const BASE = 'https://api.the-odds-api.com/v4';

async function oddsApi(path, params) {
  const u = new URL(`${BASE}${path}`);
  for (const [k, val] of Object.entries({ ...params, apiKey: config.oddsApiKey })) u.searchParams.set(k, val);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(u, { signal: ctrl.signal });
    const remaining = res.headers.get('x-requests-remaining');
    if (!res.ok) throw new Error(`Odds API ${res.status} for ${path}`);
    return { data: await res.json(), remaining };
  } finally {
    clearTimeout(t);
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Consensus price across bookmakers, then apply our margin. Returns thousandths. */
export function priceOutcome(prices, margin) {
  if (!prices.length) return null;
  const fair = median(prices);
  const ours = Math.floor(fair * (1 - margin) * 100) / 100; // round down to 2dp
  const milli = Math.round(ours * 1000);
  return milli >= 1010 ? milli : null;
}

export function buildH2H(apiEvent, margin) {
  const byName = new Map();
  for (const bk of apiEvent.bookmakers || []) {
    const mk = (bk.markets || []).find((m) => m.key === 'h2h');
    for (const o of mk?.outcomes || []) {
      if (typeof o.price !== 'number' || !(o.price > 1)) continue;
      if (!byName.has(o.name)) byName.set(o.name, []);
      byName.get(o.name).push(o.price);
    }
  }
  const order = (n) => (n === apiEvent.home_team ? 0 : n === 'Draw' ? 1 : n === apiEvent.away_team ? 2 : 3);
  const out = [];
  for (const [name, prices] of byName) {
    const odds = priceOutcome(prices, margin);
    if (odds) out.push({ name, odds, sort: order(name) });
  }
  return out.sort((a, b) => a.sort - b.sort);
}

async function upsertEvent(sport, ev, margin) {
  const start = new Date(ev.commence_time);
  if (!(start > new Date())) return 'skipped';
  const sels = buildH2H(ev, margin);
  if (sels.length < 2) return 'skipped';
  return tx(async (db) => {
    const e = (await db.query(
      `INSERT INTO events(sport_key, sport_title, league, home_team, away_team, start_time, source, external_id)
       VALUES ($1,$2,$3,$4,$5,$6,'oddsapi',$7)
       ON CONFLICT (external_id) DO UPDATE SET start_time = EXCLUDED.start_time, sport_title = EXCLUDED.sport_title,
         league = EXCLUDED.league, updated_at = now()
         WHERE events.status = 'scheduled'
       RETURNING id`,
      [sport.key, sport.group, sport.title, ev.home_team, ev.away_team, start, `oddsapi:${ev.id}`]
    )).rows[0];
    if (!e) return 'skipped';
    let m = (await db.query("SELECT * FROM markets WHERE event_id = $1 AND type = 'h2h' FOR UPDATE", [e.id])).rows[0];
    if (!m) {
      m = (await db.query(
        "INSERT INTO markets(event_id, type, name, auto_odds) VALUES ($1,'h2h','Match Result',TRUE) RETURNING *",
        [e.id]
      )).rows[0];
    }
    if (!m.auto_odds || m.status !== 'open') return 'kept';
    for (const s of sels) {
      await db.query(
        `INSERT INTO selections(market_id, name, odds_milli, sort_order) VALUES ($1,$2,$3,$4)
         ON CONFLICT (market_id, name) DO UPDATE SET odds_milli = EXCLUDED.odds_milli, updated_at = now()
           WHERE selections.result = 'pending' AND selections.odds_milli <> EXCLUDED.odds_milli`,
        [m.id, s.name, s.odds, s.sort]
      );
    }
    return 'upserted';
  });
}

/** Auto-settle h2h markets of finished imported events using official scores. */
async function settleFromScores(sportKey) {
  const { data } = await oddsApi(`/sports/${sportKey}/scores`, { daysFrom: '3', dateFormat: 'iso' });
  let settled = 0;
  for (const s of data) {
    if (!s.completed || !Array.isArray(s.scores)) continue;
    const ext = `oddsapi:${s.id}`;
    const home = s.scores.find((x) => x.name === s.home_team);
    const away = s.scores.find((x) => x.name === s.away_team);
    if (!home || !away) continue;
    const hs = Number.parseInt(home.score, 10);
    const as = Number.parseInt(away.score, 10);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    await tx(async (db) => {
      const ev = (await db.query("SELECT * FROM events WHERE external_id = $1 AND status = 'scheduled' FOR UPDATE", [ext])).rows[0];
      if (!ev) return;
      await db.query("UPDATE events SET status = 'finished', home_score = $2, away_score = $3, updated_at = now() WHERE id = $1", [ev.id, hs, as]);
      const m = (await db.query("SELECT id FROM markets WHERE event_id = $1 AND type = 'h2h' AND status IN ('open','suspended')", [ev.id])).rows[0];
      if (!m) return;
      const sels = (await db.query('SELECT id, name FROM selections WHERE market_id = $1', [m.id])).rows;
      const winner = hs > as ? ev.home_team : as > hs ? ev.away_team : 'Draw';
      const hasWinner = sels.some((x) => x.name === winner);
      const results = {};
      for (const x of sels) results[x.id] = hasWinner ? (x.name === winner ? 'won' : 'lost') : 'void';
      await settleMarket(db, { marketId: m.id, results, voidAll: !hasWinner });
      settled++;
    });
  }
  return settled;
}

const GROUP_NAMES = { Soccer: 'Football' };
let sportsCache = null;

/** Every in-season league The Odds API covers (this call is free of quota). */
export async function listFeedSports() {
  if (sportsCache && Date.now() - sportsCache.at < 6 * 3600_000) return sportsCache.list;
  const { data } = await oddsApi('/sports', {});
  const wanted = config.oddsApiSports;
  const groups = config.oddsApiGroups;
  const list = data
    .filter((x) => x.active && !x.has_outrights)
    .filter((x) => wanted.includes('all') || wanted.includes(x.key))
    .filter((x) => !groups.length || groups.includes(String(x.group).toLowerCase()))
    .map((x) => ({ key: x.key, group: GROUP_NAMES[x.group] || x.group, title: x.title, description: x.description }));
  sportsCache = { at: Date.now(), list };
  return list;
}

async function loadState() {
  const v = (await query("SELECT value FROM settings WHERE key = 'odds_sync_state'")).rows[0]?.value;
  return v && typeof v === 'object' ? { sports: {}, ...v } : { sports: {} };
}
async function saveState(state) {
  await query(
    `INSERT INTO settings(key, value) VALUES ('odds_sync_state', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify(state)]
  );
}

/** Only ask for scores where we actually have started, unsettled feed events (saves quota). */
async function needsScores(sportKey) {
  const { rows } = await query(
    `SELECT 1 FROM events WHERE sport_key = $1 AND source = 'oddsapi' AND status = 'scheduled'
       AND start_time < now() - interval '90 minutes' AND start_time > now() - interval '3 days' LIMIT 1`,
    [sportKey]
  );
  return rows.length > 0;
}

/**
 * Sync leagues stalest-first until the time budget is used. Each run continues
 * where the previous one stopped, so every league is covered across runs even
 * though serverless functions have short time limits.
 */
export async function syncOdds({ force = false, actorId = null, budgetMs = 20_000 } = {}) {
  if (!config.oddsApiKey) return { ok: false, reason: 'ODDS_API_KEY not set' };
  const started = Date.now();
  const interval = config.oddsSyncIntervalMinutes * 60_000;
  const sports = await listFeedSports();
  const state = await loadState();
  const due = sports
    .map((sp) => ({ sp, at: state.sports[sp.key]?.at ? new Date(state.sports[sp.key].at).getTime() : 0 }))
    .filter((x) => force || Date.now() - x.at >= interval)
    .sort((a, b) => a.at - b.at);
  const summary = { ok: true, at: new Date().toISOString(), leaguesAvailable: sports.length, processed: 0, remainingDue: 0, sports: {}, remaining: state.remaining ?? null };
  for (const { sp } of due) {
    if (Date.now() - started > budgetMs) {
      summary.remainingDue++;
      continue;
    }
    const s = { upserted: 0, skipped: 0, kept: 0, settled: 0, error: null };
    try {
      const { data, remaining } = await oddsApi(`/sports/${sp.key}/odds`, {
        regions: config.oddsApiRegions, markets: 'h2h', oddsFormat: 'decimal', dateFormat: 'iso',
      });
      if (remaining !== null) summary.remaining = remaining;
      for (const ev of data) s[await upsertEvent(sp, ev, config.oddsMargin)]++;
      if (config.oddsAutoSettle && (await needsScores(sp.key))) s.settled = await settleFromScores(sp.key);
    } catch (e) {
      console.error('[odds] sync error', sp.key, e.message);
      s.error = e.message;
    }
    state.sports[sp.key] = { at: new Date().toISOString(), title: sp.title, group: sp.group, events: s.upserted, error: s.error };
    summary.sports[sp.key] = s;
    summary.processed++;
    // Out of quota: stop early instead of burning through every league with errors.
    if (s.error && /\b(401|429)\b/.test(s.error)) break;
  }
  state.remaining = summary.remaining;
  state.lastRun = summary.at;
  await saveState(state);
  await query(
    `INSERT INTO settings(key, value) VALUES ('odds_sync', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify({ at: summary.at, remaining: summary.remaining, leaguesAvailable: summary.leaguesAvailable, processed: summary.processed, remainingDue: summary.remainingDue })]
  );
  if (summary.processed) await audit({ query }, { actorId, action: 'odds.sync', details: { processed: summary.processed, remainingDue: summary.remainingDue, remaining: summary.remaining } });
  return summary;
}
