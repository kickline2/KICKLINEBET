import {
  h, mount, api, money, toMajor, fmtDateTime, state, toast, modal, confirmDialog, field, input, formValues, busy, swallow,
  statusPill, reauthFields,
} from './core.js';
import { betCard } from './views.js';
import { lineChart, barChart, rankBars } from './charts.js';

const NAV = [
  ['#/admin', 'Dashboard'], ['#/admin/events', 'Events'], ['#/admin/bets', 'Bets'], ['#/admin/users', 'Users'],
  ['#/admin/withdrawals', 'Withdrawals'], ['#/admin/settings', 'Settings'], ['#/admin/audit', 'Audit log'],
];

function shell(root, active, ...content) {
  mount(root, h('div', { class: 'admin' },
    h('nav', { class: 'admin-nav', 'aria-label': 'Admin' }, NAV.map(([href, label]) => h('a', { href, class: href === active ? 'active' : '' }, label))),
    h('div', { class: 'admin-main' }, ...content)));
}

const vals2 = (form) => {
  const v = formValues(form);
  if (!v.code) delete v.code;
  return v;
};

async function formModal(title, fields, submitLabel, onSubmit) {
  const form = h('form', { class: 'stack' }, fields);
  return modal(title, form, [
    { label: 'Cancel', value: null },
    { label: submitLabel, class: 'btn-primary', handler: async () => {
      if (!form.reportValidity()) return false;
      try {
        return (await onSubmit(vals2(form))) ?? true;
      } catch (e) {
        toast(e.message, 'error');
        return false;
      }
    } },
  ]);
}

export async function adminRouter(root, path, params) {
  if (state.user?.role !== 'admin') {
    mount(root, h('div', { class: 'page' }, h('p', null, 'Admin access required.')));
    return;
  }
  if (!state.user.totpEnabled) {
    mount(root, h('div', { class: 'page narrow' }, h('h1', null, 'Admin'), h('div', { class: 'card' },
      h('p', null, 'For security, admin tools require two-factor authentication.'),
      h('a', { class: 'btn btn-primary', href: '#/account' }, 'Set up 2FA'))));
    return;
  }
  const routes = {
    '': overview, events, bets, users, withdrawals, settings, audit,
  };
  if (path === 'users' && params.id) return userDetail(root, params.id);
  return (routes[path] || overview)(root);
}

// ---------------- Dashboard ----------------
let dashDays = '30';
let dashTimer = null;

const compact = (minor) => {
  const v = Number(minor || 0) / 100;
  const a = Math.abs(v);
  const str = a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0);
  return `GHS ${str}`;
};

function delta(cur, prev, { invert = false } = {}) {
  if (!prev && !cur) return h('span', { class: 'delta flat' }, 'no change');
  if (!prev) return h('span', { class: 'delta up' }, '▲ new');
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const good = invert ? pct < 0 : pct > 0;
  if (Math.abs(pct) < 0.5) return h('span', { class: 'delta flat' }, '● 0%');
  return h('span', { class: `delta ${good ? 'up' : 'down'}`, title: 'vs previous period' }, `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}%`);
}

function kpi(label, value, sub, d) {
  return h('div', { class: 'stat' },
    h('div', { class: 'muted small' }, label),
    h('div', { class: 'stat-val' }, value),
    h('div', { class: 'stat-sub' }, d || null, sub ? h('span', { class: 'muted small' }, sub) : null));
}

async function overview(root) {
  clearInterval(dashTimer);
  const range = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Date range' },
    [['7', '7 days'], ['30', '30 days'], ['90', '90 days']].map(([d, l]) =>
      h('button', { class: `tab${dashDays === d ? ' active' : ''}`, role: 'tab', 'aria-selected': String(dashDays === d), onclick: () => { dashDays = d; overview(root).catch((e) => toast(e.message, 'error')); } }, l)));
  const updated = h('span', { class: 'muted small' });
  const body = h('div', { class: 'dash' }, h('div', { class: 'stats' }, Array.from({ length: 8 }, () => h('div', { class: 'stat skeleton-tile' }))));
  shell(root, '#/admin',
    h('div', { class: 'row-between' }, h('div', null, h('h1', null, 'Dashboard'), updated), range),
    body);
  const d = await api('GET', `/api/admin/dashboard?days=${dashDays}`);
  updated.textContent = `Live data · updated ${new Date().toLocaleTimeString()} · refreshes every minute`;
  const k = d.kpis;
  const p = d.previous;
  const sn = d.snapshot;
  const margin = k.settled_stakes ? (k.ggr / k.settled_stakes) * 100 : 0;

  const alerts = [];
  if (sn.pending_withdrawals) alerts.push(h('a', { class: 'alert-item', href: '#/admin/withdrawals' }, `${sn.pending_withdrawals} withdrawal(s) waiting (${money(sn.pending_withdrawals_amount)})`));
  if (sn.awaiting_results) alerts.push(h('a', { class: 'alert-item', href: '#/admin/events' }, `${sn.awaiting_results} event(s) need results`));
  if (sn.kyc_pending) alerts.push(h('a', { class: 'alert-item', href: '#/admin/users' }, `${sn.kyc_pending} player(s) waiting for KYC review`));
  if (!d.integrations.paystack) alerts.push(h('span', { class: 'alert-item' }, 'Paystack not connected: deposits are off'));
  if (!d.integrations.oddsApi) alerts.push(h('span', { class: 'alert-item' }, 'Odds feed not connected: add ODDS_API_KEY'));

  const labels = d.series.map((r) => r.day);
  const stakesChart = h('div', { class: 'chart' });
  const ggrChart = h('div', { class: 'chart' });
  const cashChart = h('div', { class: 'chart' });
  const leagues = h('div', { class: 'rank' });
  const sync = d.integrations.lastOddsSync;
  const statusTotal = Object.values(d.statusMix).reduce((a, b) => a + b, 0);

  mount(body,
    alerts.length ? h('div', { class: 'alert-strip', role: 'status' }, h('strong', null, 'Needs attention'), alerts) : null,
    h('div', { class: 'stats' },
      kpi('Gross gaming revenue', money(k.ggr), `${margin.toFixed(1)}% hold`, delta(k.ggr, p.ggr)),
      kpi('Stakes', money(k.stakes), `${k.bets} bets`, delta(k.stakes, p.stakes)),
      kpi('Payouts', money(k.payouts), null, delta(k.payouts, p.payouts, { invert: true })),
      kpi('Active bettors', String(k.active_bettors), `${k.new_players} new players`, delta(k.active_bettors, p.active_bettors)),
      kpi('Deposits', money(k.deposits), null, delta(k.deposits, p.deposits)),
      kpi('Withdrawals paid', money(k.withdrawals), `net ${money(k.deposits - k.withdrawals)}`, delta(k.withdrawals, p.withdrawals, { invert: true })),
      kpi('Player balances', money(sn.balances), `${sn.players} players`),
      kpi('Open bets', String(sn.open_bets), `max payout ${money(sn.open_liability)}`)),
    h('div', { class: 'grid-2 dash-grid' },
      h('section', { class: 'card' }, h('h2', null, 'Stakes vs payouts'), h('p', { class: 'muted small' }, 'Daily, GHS'), stakesChart),
      h('section', { class: 'card' }, h('h2', null, 'Daily GGR'), h('p', { class: 'muted small' }, 'Settled stakes minus payouts. Below zero = players won.'), ggrChart)),
    h('div', { class: 'grid-2 dash-grid' },
      h('section', { class: 'card' }, h('h2', null, 'Deposits vs withdrawals'), h('p', { class: 'muted small' }, 'Daily, GHS'), cashChart),
      h('section', { class: 'card' }, h('h2', null, 'Top leagues by stake'), h('p', { class: 'muted small' }, `Last ${d.days} days`), leagues)),
    h('div', { class: 'grid-2 dash-grid' },
      h('section', { class: 'card' }, h('h2', null, 'Risk: biggest liabilities'), h('p', { class: 'muted small' }, 'Open single bets per selection. Consider suspending or shortening odds on outliers.'),
        d.exposure.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, ['Selection', 'Event', 'Bets', 'Staked', 'Liability'].map((x, i) => h('th', { class: i > 1 ? 'num' : '' }, x)))),
          h('tbody', null, d.exposure.map((x) => h('tr', null,
            h('td', null, h('strong', null, x.selection), h('div', { class: 'muted small' }, x.market)),
            h('td', null, x.event, h('div', { class: 'muted small' }, fmtDateTime(x.start_time))),
            h('td', { class: 'num' }, x.bets), h('td', { class: 'num' }, money(x.stakes)), h('td', { class: 'num neg' }, money(x.liability))))))) : h('p', { class: 'muted' }, 'No open single bets.')),
      h('section', { class: 'card' }, h('h2', null, 'Biggest bets'), h('p', { class: 'muted small' }, `Last ${d.days} days`),
        d.bigBets.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, ['Player', 'Type', 'Stake', 'Odds', 'Status'].map((x, i) => h('th', { class: i === 2 || i === 3 ? 'num' : '' }, x)))),
          h('tbody', null, d.bigBets.map((b) => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/admin/users/${b.user_id}`; } },
            h('td', null, b.display_name, h('div', { class: 'muted small' }, fmtDateTime(b.created_at))),
            h('td', null, b.legs > 1 ? `${b.legs}-fold` : 'Single'),
            h('td', { class: 'num' }, money(b.stake)), h('td', { class: 'num' }, Number(b.total_odds).toFixed(2)),
            h('td', null, statusPill(b.status))))))) : h('p', { class: 'muted' }, 'No bets yet.'))),
    h('div', { class: 'grid-2 dash-grid' },
      h('section', { class: 'card' }, h('h2', null, 'Bet outcomes'), h('p', { class: 'muted small' }, `Bets placed in the last ${d.days} days`),
        statusTotal ? h('div', { class: 'outcomes' }, ['open', 'won', 'lost', 'void'].map((st) => h('div', { class: 'outcome' },
          h('div', { class: 'stat-val' }, String(d.statusMix[st] || 0)), statusPill(st),
          h('div', { class: 'muted small' }, `${(((d.statusMix[st] || 0) / statusTotal) * 100).toFixed(0)}%`)))) : h('p', { class: 'muted' }, 'No bets yet.')),
      h('section', { class: 'card' }, h('h2', null, 'Operations'),
        h('dl', { class: 'kv' },
          h('dt', null, 'Upcoming events'), h('dd', null, String(sn.upcoming_events)),
          h('dt', null, 'Paystack'), h('dd', null, d.integrations.paystack ? (d.integrations.paystackTransfers ? 'Connected · automatic payouts' : 'Connected · manual payouts') : 'Not configured'),
          h('dt', null, 'Odds feed'), h('dd', null, d.integrations.oddsApi ? 'Connected' : 'Not configured (add ODDS_API_KEY)'),
          h('dt', null, 'Last odds sync'), h('dd', null, sync ? `${fmtDateTime(sync.at)} · ${sync.leaguesAvailable ?? '?'} leagues in season` : 'Never'),
          h('dt', null, 'API credits'), h('dd', null, sync ? `${sync.remaining ?? '?'} left this month · ${sync.creditsUsedToday ?? 0}/${sync.dailyBudget ?? '?'} used today` : '—')),
        d.integrations.oddsApi ? h('button', { class: 'btn btn-ghost', onclick: (e) => busy(e.target, async () => {
          const r = await api('POST', '/api/admin/odds/sync');
          if (!r.ok) { toast(r.reason || 'Sync failed', 'error'); return; }
          const vals = Object.values(r.sports || {});
          const events = vals.reduce((a, x) => a + x.upserted, 0);
          const errors = vals.filter((x) => x.error).length;
          const why = { daily_credit_budget: `Today's API credit budget is used (${r.creditsUsedToday}/${r.dailyBudget}); more leagues sync tomorrow.`, monthly_quota_reserve: 'Odds API monthly credits are nearly exhausted; upgrade your plan or wait for the reset.', time: 'Click again to continue.' }[r.stoppedBy] || '';
          toast(`Synced ${r.processed} of ${r.leaguesAvailable} leagues (${events} matches updated${errors ? `, ${errors} errors` : ''}). ${r.remainingDue ? `${r.remainingDue} leagues still due. ` : ''}${why}`, errors ? 'error' : 'success');
          overview(root);
        }).catch(swallow) }, 'Sync odds now') : null)));

  const redraw = [
    lineChart(stakesChart, { labels, fmt: money, axisFmt: compact, series: [
      { name: 'Stakes', cls: 's1', values: d.series.map((r) => r.stakes) },
      { name: 'Payouts', cls: 's2', values: d.series.map((r) => r.payouts) },
    ] }),
    barChart(ggrChart, { labels, fmt: money, axisFmt: compact, negCls: 's2', series: [{ name: 'GGR', cls: 's1', values: d.series.map((r) => r.ggr) }] }),
    barChart(cashChart, { labels, fmt: money, axisFmt: compact, series: [
      { name: 'Deposits', cls: 's1', values: d.series.map((r) => r.deposits) },
      { name: 'Withdrawals', cls: 's2', values: d.series.map((r) => r.withdrawals) },
    ] }),
  ];
  if (d.topLeagues.length) rankBars(leagues, d.topLeagues, { label: (r) => r.league, sub: (r) => `${r.sport} · ${r.bets} bets`, value: (r) => Number(r.stakes), fmt: money });
  else mount(leagues, h('p', { class: 'muted' }, 'No bets yet.'));

  let rt;
  const onResize = () => { clearTimeout(rt); rt = setTimeout(() => { if (stakesChart.isConnected) redraw.forEach((f) => f()); else window.removeEventListener('resize', onResize); }, 150); };
  window.addEventListener('resize', onResize);
  dashTimer = setInterval(() => {
    if (!body.isConnected) { clearInterval(dashTimer); return; }
    if (document.visibilityState === 'visible' && !document.querySelector('.modal-overlay')) overview(root).catch(swallow);
  }, 60_000);
}

// ---------------- Events ----------------
async function events(root) {
  let status = 'upcoming';
  const list = h('div');
  const tabs = h('div', { class: 'tabs' });
  const q = input({ type: 'search', placeholder: 'Search teams' });
  const load = async () => {
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.s === status));
    const qs = new URLSearchParams({ status });
    if (q.value.trim()) qs.set('q', q.value.trim());
    const { events } = await api('GET', `/api/admin/events?${qs}`);
    mount(list, events.length ? events.map((e) => adminEventCard(e, load)) : h('div', { class: 'empty' }, 'No events.'));
  };
  for (const [s, l] of [['upcoming', 'Upcoming'], ['awaiting', 'Awaiting result'], ['finished', 'Finished'], ['cancelled', 'Cancelled']])
    tabs.appendChild(h('button', { class: 'tab', dataset: { s }, onclick: () => { status = s; load().catch(swallow); } }, l));
  let t;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load().catch(swallow), 300); });
  shell(root, '#/admin/events',
    h('div', { class: 'row-between' }, h('h1', null, 'Events'), h('button', { class: 'btn btn-primary', onclick: () => createEventModal(load) }, '+ New event')),
    h('div', { class: 'row-between' }, tabs, q), list);
  await load();
}

function selectionRows(container, defaults) {
  const add = (name = '', odds = '') => {
    const row = h('div', { class: 'sel-row' },
      input({ placeholder: 'Selection', value: name, required: true, maxlength: 80, class: 'input sel-n' }),
      input({ placeholder: 'Odds e.g. 2.10', value: odds, required: true, inputmode: 'decimal', pattern: '\\d+(\\.\\d{1,3})?', class: 'input sel-o' }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove', onclick: () => row.remove() }, '×'));
    container.appendChild(row);
  };
  defaults.forEach(([n, o]) => add(n, o));
  return add;
}
const readSelections = (container) => [...container.querySelectorAll('.sel-row')].map((r) => ({ name: r.querySelector('.sel-n').value.trim(), odds: r.querySelector('.sel-o').value.trim() }));

function createEventModal(reload) {
  const home = input({ name: 'homeTeam', required: true, maxlength: 80 });
  const away = input({ name: 'awayTeam', required: true, maxlength: 80 });
  const sels = h('div', { class: 'sel-rows' });
  const add = selectionRows(sels, [['Home', ''], ['Draw', ''], ['Away', '']]);
  const local = new Date(Date.now() + 86400_000);
  local.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const dt = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:00`;
  formModal('New event', [
    h('div', { class: 'grid-2' }, field('Sport', input({ name: 'sportTitle', value: 'Football', required: true })), field('League', input({ name: 'league', placeholder: 'Ghana Premier League' }))),
    h('div', { class: 'grid-2' }, field('Home team', home), field('Away team', away)),
    field('Kick-off (your local time)', input({ type: 'datetime-local', name: 'startTime', value: dt, required: true })),
    h('h4', null, 'Match Result market'),
    h('p', { class: 'muted small' }, 'Selections named after the teams (or Home/Draw/Away) are auto-settled when you enter the final score.'),
    sels, h('button', { type: 'button', class: 'link-btn', onclick: () => add() }, '+ Add selection'),
  ], 'Create event', async (v) => {
    const selections = readSelections(sels).map((s) => ({ ...s, name: s.name === 'Home' ? v.homeTeam.trim() : s.name === 'Away' ? v.awayTeam.trim() : s.name }));
    await api('POST', '/api/admin/events', {
      sportTitle: v.sportTitle, league: v.league || null, homeTeam: v.homeTeam, awayTeam: v.awayTeam,
      startTime: new Date(v.startTime).toISOString(), markets: [{ name: 'Match Result', selections }],
    });
    toast('Event created', 'success');
    reload();
  });
}

function adminEventCard(e, reload) {
  const started = new Date(e.startTime) <= new Date();
  return h('article', { class: 'card admin-event' },
    h('div', { class: 'row-between' },
      h('div', null, h('strong', null, `${e.homeTeam} v ${e.awayTeam}`), h('div', { class: 'muted small' }, `#${e.id} · ${e.league || e.sportTitle} · ${fmtDateTime(e.startTime)} · ${e.source}`),
        e.homeScore !== null ? h('div', null, `Final score: ${e.homeScore}–${e.awayScore}`) : null),
      h('div', { class: 'btn-row' }, statusPill(e.status),
        e.status === 'scheduled' && !started ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => editEventModal(e, reload) }, 'Edit') : null,
        e.status === 'scheduled' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => addMarketModal(e, reload) }, '+ Market') : null,
        e.status === 'scheduled' && started ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => finishModal(e, reload) }, 'Enter result') : null,
        e.status !== 'cancelled' ? h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
          if (!(await confirmDialog('Cancel event', 'All unsettled markets will be voided and stakes returned. Continue?', 'Cancel event', 'btn-danger'))) return;
          try { await api('POST', `/api/admin/events/${e.id}/cancel`); toast('Event cancelled', 'success'); reload(); } catch (err) { toast(err.message, 'error'); }
        } }, 'Cancel') : null)),
    e.markets.map((m) => h('div', { class: 'admin-market' },
      h('div', { class: 'row-between' }, h('div', null, h('strong', null, m.name), ' ', statusPill(m.status), m.autoOdds ? h('span', { class: 'muted small' }, ' · feed odds') : null),
        h('div', { class: 'btn-row' },
          m.status === 'open' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => setMarket(m.id, 'suspended', reload) }, 'Suspend') : null,
          m.status === 'suspended' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => setMarket(m.id, 'open', reload) }, 'Reopen') : null,
          ['open', 'suspended'].includes(m.status) && started ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => settleModal(e, m, reload) }, 'Settle') : null,
          ['open', 'suspended'].includes(m.status) ? h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => {
            if (!(await confirmDialog('Void market', 'All selections will be void and affected bets recalculated. Continue?', 'Void', 'btn-danger'))) return;
            try { const r = await api('POST', `/api/admin/markets/${m.id}/settle`, { void: true }); toast(`Market voided (${r.betsGraded} bets graded)`, 'success'); reload(); } catch (err) { toast(err.message, 'error'); }
          } }, 'Void') : null)),
      h('div', { class: 'admin-sels' }, m.selections.map((s) => h('div', { class: `admin-sel result-${s.result}` },
        h('span', null, s.name), h('strong', null, s.odds),
        ['open', 'suspended'].includes(m.status) ? h('button', { class: 'link-btn small', onclick: () => editOdds(s, reload) }, 'edit') : (s.result !== 'pending' ? statusPill(s.result) : null)))))));
}

async function setMarket(id, status, reload) {
  try { await api('PATCH', `/api/admin/markets/${id}`, { status }); reload(); } catch (e) { toast(e.message, 'error'); }
}

function editOdds(s, reload) {
  formModal(`Odds: ${s.name}`, [field('Decimal odds', input({ name: 'odds', value: s.odds, required: true, inputmode: 'decimal' }), 'Manual edits stop the odds feed updating this market.')],
    'Save', async (v) => { await api('PATCH', `/api/admin/selections/${s.id}`, { odds: v.odds }); toast('Odds updated', 'success'); reload(); });
}

function editEventModal(e, reload) {
  const d = new Date(e.startTime);
  const pad = (n) => String(n).padStart(2, '0');
  formModal('Edit event', [
    field('Home team', input({ name: 'homeTeam', value: e.homeTeam, required: true })),
    field('Away team', input({ name: 'awayTeam', value: e.awayTeam, required: true })),
    field('League', input({ name: 'league', value: e.league || '' })),
    field('Kick-off', input({ type: 'datetime-local', name: 'startTime', required: true, value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` })),
  ], 'Save', async (v) => {
    await api('PATCH', `/api/admin/events/${e.id}`, { ...v, league: v.league || null, startTime: new Date(v.startTime).toISOString() });
    toast('Event updated', 'success');
    reload();
  });
}

function addMarketModal(e, reload) {
  const sels = h('div', { class: 'sel-rows' });
  const add = selectionRows(sels, [['', ''], ['', '']]);
  formModal(`Add market: ${e.homeTeam} v ${e.awayTeam}`, [
    field('Market name', input({ name: 'name', placeholder: 'e.g. Over/Under 2.5 Goals', required: true })),
    sels, h('button', { type: 'button', class: 'link-btn', onclick: () => add() }, '+ Add selection'),
  ], 'Add market', async (v) => {
    await api('POST', `/api/admin/events/${e.id}/markets`, { name: v.name, selections: readSelections(sels) });
    toast('Market added', 'success');
    reload();
  });
}

function finishModal(e, reload) {
  formModal(`Result: ${e.homeTeam} v ${e.awayTeam}`, [
    h('div', { class: 'grid-2' }, field(e.homeTeam, input({ name: 'homeScore', type: 'number', min: 0, required: true })), field(e.awayTeam, input({ name: 'awayScore', type: 'number', min: 0, required: true }))),
    h('p', { class: 'muted small' }, 'The Match Result market settles automatically. Settle other markets individually.'),
  ], 'Confirm result', async (v) => {
    const r = await api('POST', `/api/admin/events/${e.id}/finish`, { homeScore: Number(v.homeScore), awayScore: Number(v.awayScore) });
    toast(r.matchResultSettled ? `Result saved; ${r.matchResultSettled.betsGraded} bets graded` : 'Result saved. Settle markets manually.', 'success');
    reload();
  });
}

function settleModal(e, m, reload) {
  const rows = m.selections.map((s) => h('div', { class: 'row-between settle-row' }, h('span', null, `${s.name} (${s.odds})`),
    h('select', { class: 'input', name: `sel_${s.id}` }, h('option', { value: 'lost' }, 'Lost'), h('option', { value: 'won' }, 'Won'), h('option', { value: 'void' }, 'Void'))));
  formModal(`Settle: ${m.name}`, [h('p', { class: 'muted small' }, `${e.homeTeam} v ${e.awayTeam}. Settlement is final and pays winners immediately.`), rows], 'Settle market', async (v) => {
    const results = {};
    for (const [k, val] of Object.entries(v)) if (k.startsWith('sel_')) results[k.slice(4)] = val;
    const r = await api('POST', `/api/admin/markets/${m.id}/settle`, { results });
    toast(`Settled; ${r.betsGraded} bets graded`, 'success');
    reload();
  });
}

// ---------------- Bets ----------------
async function bets(root) {
  let status = 'open';
  const list = h('div');
  const tabs = h('div', { class: 'tabs' });
  const load = async () => {
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.s === status));
    const { bets } = await api('GET', `/api/admin/bets?status=${status}`);
    mount(list, bets.length ? bets.map((b) => betCard(b, { admin: true })) : h('div', { class: 'empty' }, 'No bets.'));
  };
  for (const [s, l] of [['open', 'Open'], ['won', 'Won'], ['lost', 'Lost'], ['void', 'Void']])
    tabs.appendChild(h('button', { class: 'tab', dataset: { s }, onclick: () => { status = s; load().catch(swallow); } }, l));
  shell(root, '#/admin/bets', h('h1', null, 'Bets'), tabs, list);
  await load();
}

// ---------------- Users ----------------
async function users(root) {
  const q = input({ type: 'search', placeholder: 'Search by email, name or phone' });
  const table = h('div');
  const load = async () => {
    const { users } = await api('GET', `/api/admin/users?${new URLSearchParams(q.value.trim() ? { q: q.value.trim() } : {})}`);
    mount(table, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['ID', 'Name', 'Email', 'Status', 'KYC', 'Balance', 'Joined'].map((x) => h('th', null, x)))),
      h('tbody', null, users.map((u) => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/admin/users/${u.id}`; } },
        h('td', null, u.id), h('td', null, u.displayName, u.role === 'admin' ? ' (admin)' : ''), h('td', null, u.email),
        h('td', null, statusPill(u.status)), h('td', null, statusPill(u.kycStatus)), h('td', { class: 'num' }, money(u.balance)), h('td', null, fmtDateTime(u.createdAt)))))));
  };
  let t;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load().catch(swallow), 300); });
  shell(root, '#/admin/users', h('h1', null, 'Users'), q, table);
  await load();
}

async function userDetail(root, id) {
  const d = await api('GET', `/api/admin/users/${id}`);
  const u = d.user;
  const reload = () => userDetail(root, id);
  const act = (label, body, cls = 'btn-ghost') => h('button', { class: `btn btn-sm ${cls}`, onclick: async (e) => {
    try { await busy(e.target, () => api('PATCH', `/api/admin/users/${id}`, body)); toast('Updated', 'success'); reload(); } catch { /* toasted */ }
  } }, label);
  shell(root, '#/admin/users',
    h('a', { href: '#/admin/users', class: 'small' }, '← All users'),
    h('h1', null, `${u.displayName} `, statusPill(u.status)),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' },
        h('dl', { class: 'kv' },
          h('dt', null, 'Email'), h('dd', null, u.email), h('dt', null, 'Phone'), h('dd', null, u.phone || '—'),
          h('dt', null, 'Date of birth'), h('dd', null, String(u.dateOfBirth).slice(0, 10)),
          h('dt', null, 'KYC'), h('dd', null, statusPill(u.kycStatus)), h('dt', null, '2FA'), h('dd', null, u.totpEnabled ? 'On' : 'Off'),
          h('dt', null, 'Self-excluded until'), h('dd', null, fmtDateTime(u.selfExcludedUntil)),
          h('dt', null, 'Locked until'), h('dd', null, fmtDateTime(u.lockedUntil)),
          h('dt', null, 'Lifetime'), h('dd', null, `${d.stats.bets} bets · staked ${money(d.stats.staked)} · returned ${money(d.stats.paid)}`)),
        h('div', { class: 'btn-row' },
          u.kycStatus !== 'verified' ? act('Mark KYC verified', { kycStatus: 'verified' }, 'btn-primary') : act('Revoke KYC', { kycStatus: 'unverified' }),
          u.kycStatus !== 'rejected' ? act('Reject KYC', { kycStatus: 'rejected' }) : null,
          u.status === 'active' ? act('Suspend', { status: 'suspended' }, 'btn-danger') : act('Reactivate', { status: 'active' }),
          u.lockedUntil ? act('Unlock login', { unlock: true }) : null)),
      h('section', { class: 'card' }, h('div', { class: 'muted' }, 'Balance'), h('div', { class: 'balance-figure' }, money(u.balance)),
        h('button', { class: 'btn btn-ghost', onclick: () => formModal('Adjust balance', [
          field('Direction', h('select', { class: 'input', name: 'direction' }, h('option', { value: 'credit' }, 'Credit (add)'), h('option', { value: 'debit' }, 'Debit (remove)'))),
          field('Amount (GHS)', input({ name: 'amount', required: true, inputmode: 'decimal' })),
          field('Reason (recorded in audit log)', input({ name: 'reason', required: true, minlength: 5 })),
          ...reauthFields(),
        ], 'Apply', async (v) => { await api('POST', `/api/admin/users/${id}/adjust`, v); toast('Balance adjusted', 'success'); reload(); }) }, 'Adjust balance'))),
    h('section', { class: 'card' }, h('h2', null, 'Ledger'), h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Date', 'Kind', 'Ref', 'Description', 'Amount', 'Balance'].map((x) => h('th', null, x)))),
      h('tbody', null, d.ledger.map((l) => h('tr', null, h('td', null, fmtDateTime(l.created_at)), h('td', null, l.kind), h('td', { class: 'mono small' }, `${l.ref_type}:${l.ref_id}`),
        h('td', null, l.description || ''), h('td', { class: `num ${l.amount > 0 ? 'pos' : 'neg'}` }, money(l.amount)), h('td', { class: 'num' }, money(l.balance_after))))))),
    h('section', { class: 'card' }, h('h2', null, 'Recent bets'), h('div', { id: 'ub' })));
  const { bets } = await api('GET', `/api/admin/bets?userId=${id}`);
  mount(root.querySelector('#ub'), bets.length ? bets.map((b) => betCard(b)) : h('p', { class: 'muted' }, 'No bets.'));
}

// ---------------- Withdrawals ----------------
async function withdrawals(root) {
  let status = 'pending';
  const list = h('div');
  const tabs = h('div', { class: 'tabs' });
  const auto = (await api('GET', '/api/admin/overview')).integrations.paystackTransfers;
  const load = async () => {
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.s === status));
    const { withdrawals } = await api('GET', `/api/admin/withdrawals?status=${status}`);
    mount(list, withdrawals.length ? h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Requested', 'User', 'Amount', 'Destination', 'Status', ''].map((x) => h('th', null, x)))),
      h('tbody', null, withdrawals.map((w) => h('tr', null,
        h('td', null, fmtDateTime(w.created_at)),
        h('td', null, h('a', { href: `#/admin/users/${w.user_id}` }, w.display_name), h('div', { class: 'muted small' }, `${w.email} · KYC ${w.kyc_status}`)),
        h('td', { class: 'num' }, money(w.amount)),
        h('td', null, `${w.method === 'mobile_money' ? 'MoMo' : 'Bank'} ${w.bank_code} ${w.account_number}`, h('div', { class: 'muted small' }, w.account_name)),
        h('td', null, statusPill(w.status), w.note ? h('div', { class: 'muted small' }, w.note) : null),
        h('td', { class: 'btn-row' },
          w.status === 'pending' && auto ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => formModal('Approve & pay via Paystack', [h('p', null, `Send ${money(w.amount)} to ${w.account_name} (${w.bank_code} ${w.account_number})?`), ...reauthFields()], 'Approve & pay',
            async (v) => { const r = await api('POST', `/api/admin/withdrawals/${w.id}/approve`, v); toast(`Transfer ${r.status}`, 'success'); load(); }) }, 'Approve & pay') : null,
          w.status === 'pending' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => formModal('Mark as paid manually', [h('p', null, `Only use after you have sent ${money(w.amount)} to ${w.account_name} yourself.`), field('Payment reference / note', input({ name: 'note', required: true, minlength: 3 })), ...reauthFields()], 'Mark paid',
            async (v) => { await api('POST', `/api/admin/withdrawals/${w.id}/mark-paid`, v); toast('Marked paid', 'success'); load(); }) }, 'Mark paid') : null,
          w.status === 'pending' ? h('button', { class: 'btn btn-sm btn-danger', onclick: () => formModal('Reject withdrawal', [h('p', null, 'Funds are returned to the player\'s balance.'), field('Reason (shown to player)', input({ name: 'reason', required: true, minlength: 3 }))], 'Reject',
            async (v) => { await api('POST', `/api/admin/withdrawals/${w.id}/reject`, v); toast('Rejected and refunded', 'success'); load(); }) }, 'Reject') : null,
          w.status === 'processing' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: async (e) => { try { const r = await busy(e.target, () => api('POST', `/api/admin/withdrawals/${w.id}/refresh`)); toast(`Status: ${r.status}`, 'info'); load(); } catch { /* toasted */ } } }, 'Refresh') : null))))) : h('div', { class: 'empty' }, 'Nothing here.'));
  };
  for (const s of ['pending', 'processing', 'paid', 'rejected', 'failed'])
    tabs.appendChild(h('button', { class: 'tab', dataset: { s }, onclick: () => { status = s; load().catch(swallow); } }, s[0].toUpperCase() + s.slice(1)));
  shell(root, '#/admin/withdrawals', h('h1', null, 'Withdrawals'),
    h('p', { class: 'muted small' }, auto ? 'Approving sends money via Paystack Transfers.' : 'Paystack transfers are off: pay out manually, then mark as paid.'), tabs, list);
  await load();
}

// ---------------- Settings ----------------
const MONEY_KEYS = ['minStake', 'maxStake', 'maxPayout', 'minDeposit', 'maxDeposit', 'minWithdrawal', 'maxWithdrawal'];
const LABELS = {
  minStake: 'Minimum stake', maxStake: 'Maximum stake', maxPayout: 'Maximum payout per bet', maxLegs: 'Max selections per bet',
  minDeposit: 'Minimum deposit', maxDeposit: 'Maximum deposit', minWithdrawal: 'Minimum withdrawal', maxWithdrawal: 'Maximum withdrawal',
  minOdds: 'Minimum odds (×1000)', maxOdds: 'Maximum odds (×1000)', bettingEnabled: 'Betting enabled', depositsEnabled: 'Deposits enabled',
  withdrawalsEnabled: 'Withdrawals enabled', requireKycForWithdrawal: 'Require KYC before withdrawal',
};
async function settings(root) {
  const { settings: s } = await api('GET', '/api/admin/settings');
  const form = h('form', { class: 'stack card' }, Object.keys(LABELS).map((k) => typeof s[k] === 'boolean'
    ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: k, checked: s[k] }), h('span', null, LABELS[k]))
    : field(MONEY_KEYS.includes(k) ? `${LABELS[k]} (GHS)` : LABELS[k], input({ name: k, value: MONEY_KEYS.includes(k) ? toMajor(s[k]) : s[k], required: true, inputmode: 'decimal' }))),
  h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save settings'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    const body = {};
    for (const [k, val] of Object.entries(v)) body[k] = typeof val === 'boolean' ? val : MONEY_KEYS.includes(k) ? Math.round(Number(val) * 100) : Number(val);
    try { await busy(form.querySelector('[type=submit]'), () => api('PUT', '/api/admin/settings', body)); toast('Settings saved', 'success'); } catch { /* toasted */ }
  });
  shell(root, '#/admin/settings', h('h1', null, 'Settings'), form);
}

// ---------------- Audit ----------------
async function audit(root) {
  const { entries } = await api('GET', '/api/admin/audit');
  shell(root, '#/admin/audit', h('h1', null, 'Audit log'), h('div', { class: 'card' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, ['Time', 'Actor', 'Action', 'Target', 'Details', 'IP'].map((x) => h('th', null, x)))),
    h('tbody', null, entries.map((a) => h('tr', null, h('td', null, fmtDateTime(a.created_at)), h('td', null, a.actor_email || 'system'), h('td', null, a.action),
      h('td', null, a.target_type ? `${a.target_type}:${a.target_id}` : ''), h('td', { class: 'mono small details' }, a.details ? JSON.stringify(a.details).slice(0, 200) : ''), h('td', { class: 'small' }, a.ip || '')))))));
}
