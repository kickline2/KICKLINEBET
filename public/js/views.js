import {
  h, mount, clear, api, money, toMajor, fmtDate, fmtDateTime, state, emit, on, saveSlip, refreshWallet, toast,
  confirmDialog, field, input, formValues, busy, swallow, statusPill, reauthFields, newIdempotencyKey,
} from './core.js';

const go = (hash) => {
  location.hash = hash;
};

// =================== Sportsbook ===================
let eventsCache = new Map(); // selectionId -> {event, market, selection}

export async function sportsbookView(root, params) {
  const sport = params.sport || null;
  const search = input({ type: 'search', placeholder: 'Search teams or leagues', 'aria-label': 'Search events', maxlength: 60 });
  const list = h('div', { class: 'events' }, skeleton());
  const sportsNav = h('nav', { class: 'sports-nav', 'aria-label': 'Sports' });
  mount(root, h('div', { class: 'book' },
    h('aside', { class: 'sports-col' }, h('h2', { class: 'col-title' }, 'Sports'), sportsNav),
    h('section', { class: 'events-col' },
      h('div', { class: 'events-head' }, h('h1', null, sport ? 'Upcoming' : 'All upcoming matches'), search),
      list)));

  api('GET', '/api/sports').then(({ sports }) => {
    mount(sportsNav,
      h('a', { href: '#/', class: !sport ? 'active' : '' }, 'All sports'),
      sports.map((s) => h('a', { href: `#/sport/${encodeURIComponent(s.key)}`, class: s.key === sport ? 'active' : '' }, s.title, h('span', { class: 'count' }, s.events))));
  }).catch(swallow);

  let timer;
  const load = async () => {
    const qs = new URLSearchParams();
    if (sport) qs.set('sport', sport);
    if (search.value.trim()) qs.set('q', search.value.trim());
    try {
      const { events } = await api('GET', `/api/events?${qs}`);
      renderEvents(list, events);
    } catch (e) {
      mount(list, h('div', { class: 'empty' }, e.message));
    }
  };
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 300);
  });
  await load();
  // Keep odds fresh while the page is open.
  const poll = setInterval(() => document.visibilityState === 'visible' && load(), 30_000);
  return () => clearInterval(poll);
}

function skeleton() {
  return Array.from({ length: 4 }, () => h('div', { class: 'event-card skeleton' }));
}

function renderEvents(list, events) {
  if (!events.length) {
    mount(list, h('div', { class: 'empty' }, h('p', null, 'No upcoming matches right now.'), h('p', { class: 'muted' }, 'Check back soon — new fixtures are added regularly.')));
    return;
  }
  // group by day
  const groups = new Map();
  for (const e of events) {
    for (const m of e.markets) for (const s of m.selections) eventsCache.set(s.id, { event: e, market: m, selection: s });
    const day = new Date(e.startTime).toDateString();
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(e);
  }
  mount(list, [...groups].map(([day, evs]) => h('div', { class: 'day-group' },
    h('h3', { class: 'day-title' }, new Date(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })),
    evs.map(eventCard))));
  syncSlipOdds();
}

function eventCard(e) {
  const [main, ...others] = e.markets;
  const extra = h('div', { class: 'more-markets', hidden: true }, others.map(marketBlock));
  return h('article', { class: 'event-card' },
    h('div', { class: 'event-meta' },
      h('span', { class: 'league' }, e.league || e.sportTitle),
      h('time', { datetime: e.startTime }, fmtDate(e.startTime))),
    h('div', { class: 'event-teams' }, h('div', null, e.homeTeam), h('div', null, e.awayTeam)),
    main ? marketBlock(main) : null,
    others.length ? h('button', { class: 'link-btn', onclick: (ev) => {
      extra.hidden = !extra.hidden;
      ev.target.textContent = extra.hidden ? `+${others.length} more markets` : 'Hide markets';
    } }, `+${others.length} more markets`) : null,
    extra);
}

function marketBlock(m) {
  const suspended = m.status !== 'open';
  return h('div', { class: 'market' },
    h('div', { class: 'market-name' }, m.name, suspended ? h('span', { class: 'pill pill-suspended' }, 'suspended') : null),
    h('div', { class: `odds-row cols-${Math.min(m.selections.length, 3)}` }, m.selections.map((s) => oddsButton(s, suspended))));
}

function oddsButton(s, suspended) {
  const inSlip = state.slip.some((x) => x.selectionId === s.id);
  const btn = h('button', {
    class: `odds-btn${inSlip ? ' selected' : ''}`, disabled: suspended, dataset: { sel: String(s.id) },
    'aria-pressed': inSlip ? 'true' : 'false', onclick: () => toggleSelection(s.id),
  }, h('span', { class: 'sel-name' }, s.name), h('span', { class: 'sel-odds' }, s.odds));
  return btn;
}

function toggleSelection(id) {
  const info = eventsCache.get(id);
  if (!info) return;
  const idx = state.slip.findIndex((x) => x.selectionId === id);
  if (idx >= 0) state.slip.splice(idx, 1);
  else {
    // replace any other selection from the same event
    state.slip = state.slip.filter((x) => x.eventId !== info.event.id);
    const max = state.config?.limits?.maxLegs || 20;
    if (state.slip.length >= max) {
      toast(`Maximum ${max} selections per bet`, 'error');
      return;
    }
    state.slip.push({
      selectionId: id, eventId: info.event.id, odds: info.selection.odds, name: info.selection.name,
      market: info.market.name, event: `${info.event.homeTeam} v ${info.event.awayTeam}`, startTime: info.event.startTime,
    });
  }
  saveSlip();
  document.querySelectorAll('.odds-btn').forEach((b) => {
    const sel = state.slip.some((x) => String(x.selectionId) === b.dataset.sel);
    b.classList.toggle('selected', sel);
    b.setAttribute('aria-pressed', sel ? 'true' : 'false');
  });
}

function syncSlipOdds() {
  let changed = false;
  for (const s of state.slip) {
    const info = eventsCache.get(s.selectionId);
    if (info && info.selection.odds !== s.odds) {
      s.newOdds = info.selection.odds;
      changed = true;
    }
  }
  if (changed) saveSlip();
}

// =================== Bet slip ===================
export function renderSlip(container) {
  const stakeInput = input({ type: 'text', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'Stake in GHS', value: sessionStake() });
  let acceptHigher = true;
  const draw = () => {
    const slip = state.slip;
    const totalOdds = slip.reduce((a, s) => a * Number(s.newOdds || s.odds), 1);
    const stake = Number(stakeInput.value) || 0;
    const payout = Math.floor(stake * 100 * totalOdds) / 100;
    const anyChanged = slip.some((s) => s.newOdds);
    const placeBtn = h('button', { class: 'btn btn-primary btn-block', disabled: !slip.length }, anyChanged ? 'Accept odds & place bet' : 'Place bet');
    placeBtn.addEventListener('click', () => placeBet(placeBtn, stakeInput, acceptHigher).catch(swallow));
    mount(container,
      h('div', { class: 'slip-head' }, h('h2', null, 'Bet slip ', h('span', { class: 'badge' }, slip.length)),
        slip.length ? h('button', { class: 'link-btn', onclick: () => { state.slip = []; saveSlip(); } }, 'Clear') : null),
      !slip.length ? h('p', { class: 'muted slip-empty' }, 'Tap any odds to add a selection.') : [
        h('ul', { class: 'slip-list' }, slip.map((s) => h('li', { class: 'slip-item' },
          h('div', { class: 'slip-sel' }, h('strong', null, s.name), h('span', { class: `slip-odds${s.newOdds ? ' changed' : ''}` }, s.newOdds ? `${s.odds} → ${s.newOdds}` : s.odds)),
          h('div', { class: 'muted small' }, `${s.market} · ${s.event}`),
          h('button', { class: 'icon-btn remove', 'aria-label': `Remove ${s.name}`, onclick: () => { state.slip = state.slip.filter((x) => x !== s); saveSlip(); } }, '×')))),
        h('div', { class: 'slip-summary' },
          h('div', { class: 'row' }, h('span', null, slip.length > 1 ? `${slip.length}-fold accumulator` : 'Single'), h('strong', null, totalOdds.toFixed(2))),
          field('Stake (GHS)', stakeInput),
          h('div', { class: 'quick-stakes' }, [5, 10, 20, 50].map((n) => h('button', { class: 'chip', onclick: () => { stakeInput.value = n.toFixed(2); draw(); } }, `+${n}`))),
          h('div', { class: 'row payout' }, h('span', null, 'Potential payout'), h('strong', null, money(Math.round(payout * 100)))),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: acceptHigher, onchange: (e) => { acceptHigher = e.target.checked; } }), ' Accept higher odds automatically'),
          state.user ? placeBtn : h('a', { class: 'btn btn-primary btn-block', href: '#/login' }, 'Log in to place bet'),
          h('p', { class: 'muted small center' }, 'Bet responsibly. 18+ only.')),
      ]);
  };
  stakeInput.addEventListener('input', () => {
    try { sessionStorage.setItem('kl_stake', stakeInput.value); } catch { /* ignore */ }
    const payoutEl = container.querySelector('.payout strong');
    const totalOdds = state.slip.reduce((a, s) => a * Number(s.newOdds || s.odds), 1);
    if (payoutEl) payoutEl.textContent = money(Math.floor((Number(stakeInput.value) || 0) * 100 * totalOdds));
  });
  on('slip', draw);
  on('auth', draw);
  draw();
}
function sessionStake() {
  try { return sessionStorage.getItem('kl_stake') || ''; } catch { return ''; }
}

async function placeBet(btn, stakeInput, acceptHigher) {
  const stake = stakeInput.value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(stake) || Number(stake) <= 0) {
    toast('Enter a valid stake, e.g. 10.00', 'error');
    stakeInput.focus();
    return;
  }
  // Accepting changed odds: the user explicitly confirmed by clicking the button showing new odds.
  for (const s of state.slip) if (s.newOdds) { s.odds = s.newOdds; delete s.newOdds; }
  const key = state.pendingBetKey || (state.pendingBetKey = newIdempotencyKey());
  await busy(btn, async () => {
    try {
      const res = await api('POST', '/api/bets', {
        idempotencyKey: key, stake, acceptOddsChanges: acceptHigher ? 'higher' : 'none',
        selections: state.slip.map((s) => ({ selectionId: s.selectionId, odds: s.odds })),
      });
      state.pendingBetKey = null;
      state.slip = [];
      saveSlip();
      toast(`Bet placed! Potential payout ${money(res.bet.potentialPayout)}`, 'success');
      refreshWallet();
      document.body.classList.remove('slip-open');
    } catch (e) {
      if (e.code === 'ODDS_CHANGED') {
        state.pendingBetKey = null;
        for (const c of e.data.changes || []) {
          const s = state.slip.find((x) => x.selectionId === c.selectionId);
          if (s) s.newOdds = c.odds;
        }
        saveSlip();
      } else if (!['NETWORK', 'INTERNAL'].includes(e.code)) {
        state.pendingBetKey = null; // definitive failure: next attempt is a new bet
      }
      if (e.code === 'INSUFFICIENT_FUNDS') {
        toast('Insufficient balance. Deposit to continue.', 'error');
        go('#/wallet');
        return;
      }
      throw e;
    }
  });
}

// =================== Auth ===================
export function loginView(root) {
  const form = h('form', { class: 'card auth-card', novalidate: true },
    h('h1', null, 'Log in'),
    field('Email', input({ type: 'email', name: 'email', autocomplete: 'username', required: true })),
    field('Password', input({ type: 'password', name: 'password', autocomplete: 'current-password', required: true })),
    h('div', { class: 'mfa', hidden: true }, field('Authenticator code', input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6 }))),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Log in'),
    h('p', { class: 'muted center' }, 'New here? ', h('a', { href: '#/register' }, 'Create an account')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const vals = formValues(form);
    if (!vals.code) delete vals.code;
    try {
      await busy(btn, async () => {
        try {
          const { user } = await api('POST', '/api/auth/login', vals);
          state.user = user;
          emit('auth');
          refreshWallet();
          toast(`Welcome back, ${user.displayName}`, 'success');
          go('#/');
        } catch (err) {
          if (err.code === 'MFA_REQUIRED') {
            form.querySelector('.mfa').hidden = false;
            form.querySelector('[name=code]').focus();
            toast(err.message, 'info');
            return;
          }
          throw err;
        }
      });
    } catch { /* toasted */ }
  });
  mount(root, h('div', { class: 'auth-wrap' }, form));
}

export function registerView(root) {
  const max = new Date();
  max.setFullYear(max.getFullYear() - 18);
  const form = h('form', { class: 'card auth-card', novalidate: true },
    h('h1', null, 'Create account'),
    field('Display name', input({ name: 'displayName', autocomplete: 'nickname', required: true, maxlength: 40 })),
    field('Email', input({ type: 'email', name: 'email', autocomplete: 'email', required: true })),
    field('Phone (optional)', input({ type: 'tel', name: 'phone', autocomplete: 'tel', placeholder: '024 123 4567' })),
    field('Date of birth', input({ type: 'date', name: 'dateOfBirth', max: max.toISOString().slice(0, 10), required: true }), 'You must be 18 or older.'),
    field('Password', input({ type: 'password', name: 'password', autocomplete: 'new-password', minlength: 10, required: true }), 'At least 10 characters. Use a passphrase.'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'acceptTerms' }), ' I am 18 or older and accept the ', h('a', { href: '#/terms' }, 'terms'), ' and ', h('a', { href: '#/responsible' }, 'responsible gambling policy'), '.'),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Create account'),
    h('p', { class: 'muted center' }, 'Already have an account? ', h('a', { href: '#/login' }, 'Log in')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const vals = formValues(form);
    if (!vals.phone) delete vals.phone;
    try {
      await busy(form.querySelector('button[type=submit]'), async () => {
        const { user } = await api('POST', '/api/auth/register', vals);
        state.user = user;
        emit('auth');
        refreshWallet();
        toast('Account created. Welcome to Kickline!', 'success');
        go('#/wallet');
      });
    } catch { /* toasted */ }
  });
  mount(root, h('div', { class: 'auth-wrap' }, form));
}

// =================== My bets ===================
export async function betsView(root) {
  let status = 'open';
  const list = h('div', { class: 'bets-list' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  let before = null;
  const more = h('button', { class: 'btn btn-ghost btn-block', hidden: true }, 'Load more');
  const load = async (reset) => {
    if (reset) { before = null; clear(list); }
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.s === status));
    const qs = new URLSearchParams({ status });
    if (before) qs.set('before', before);
    const { bets } = await api('GET', `/api/bets?${qs}`);
    if (reset && !bets.length) list.appendChild(h('div', { class: 'empty' }, status === 'open' ? 'You have no open bets.' : 'No settled bets yet.'));
    bets.forEach((b) => list.appendChild(betCard(b)));
    before = bets.length ? bets[bets.length - 1].id : before;
    more.hidden = bets.length < 30;
  };
  for (const [s, label] of [['open', 'Open'], ['settled', 'Settled']])
    tabs.appendChild(h('button', { class: 'tab', dataset: { s }, onclick: () => { status = s; load(true).catch((e) => toast(e.message, 'error')); } }, label));
  more.addEventListener('click', () => load(false).catch(swallow));
  mount(root, h('div', { class: 'page narrow' }, h('h1', null, 'My bets'), tabs, list, more));
  await load(true);
}

export function betCard(b, { admin = false } = {}) {
  return h('article', { class: `bet-card status-${b.status}` },
    h('div', { class: 'bet-top' },
      h('div', null, h('strong', null, b.legs.length > 1 ? `${b.legs.length}-fold accumulator` : 'Single'), h('span', { class: 'muted small' }, ` #${b.id} · ${fmtDateTime(b.createdAt)}`), admin ? h('a', { class: 'small', href: `#/admin/users/${b.userId}` }, ` user ${b.userId}`) : null),
      statusPill(b.status)),
    h('ul', { class: 'legs' }, b.legs.map((l) => h('li', { class: `leg leg-${l.result}` },
      h('div', null, h('strong', null, l.selection), ' @ ', l.odds),
      h('div', { class: 'muted small' }, `${l.market} · ${l.event}${l.score ? ` (${l.score})` : ''}`),
      l.result !== 'pending' ? statusPill(l.result) : null))),
    h('div', { class: 'bet-foot' },
      h('span', null, 'Stake ', h('strong', null, money(b.stake))),
      h('span', null, 'Odds ', h('strong', null, b.totalOdds)),
      b.status === 'open' ? h('span', null, 'To return ', h('strong', null, money(b.potentialPayout))) : h('span', null, 'Returned ', h('strong', null, money(b.payout)))));
}

// =================== Wallet ===================
export async function walletView(root, params, query) {
  const balance = h('div', { class: 'balance-figure' }, '…');
  const sub = h('div', { class: 'muted small' });
  const depForm = depositForm();
  const wdForm = withdrawForm();
  const tx = h('div', { class: 'tx-list' });
  const pending = h('div');
  mount(root, h('div', { class: 'page' },
    h('h1', null, 'Wallet'),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card balance-card' }, h('div', { class: 'muted' }, 'Available balance'), balance, sub),
      h('section', { class: 'card' }, h('h2', null, 'Deposit'), depForm)),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' }, h('h2', null, 'Withdraw'), wdForm),
      h('section', { class: 'card' }, h('h2', null, 'Withdrawal requests'), pending)),
    h('section', { class: 'card' }, h('h2', null, 'Transactions'), tx)));

  const refresh = async () => {
    await refreshWallet();
    const w = state.wallet;
    if (w) {
      balance.textContent = money(w.balance);
      sub.textContent = `${w.openBets} open bet${w.openBets === 1 ? '' : 's'} (${money(w.openStakes)} staked) · ${money(w.pendingWithdrawals)} pending withdrawal`;
    }
    const [{ transactions }, { withdrawals }] = await Promise.all([api('GET', '/api/wallet/transactions'), api('GET', '/api/wallet/withdrawals')]);
    mount(tx, transactions.length ? h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Type'), h('th', null, 'Details'), h('th', { class: 'num' }, 'Amount'), h('th', { class: 'num' }, 'Balance'))),
      h('tbody', null, transactions.map((t) => h('tr', null,
        h('td', null, fmtDateTime(t.createdAt)), h('td', null, t.kind.replace(/_/g, ' ')), h('td', { class: 'muted' }, t.description || ''),
        h('td', { class: `num ${t.amount > 0 ? 'pos' : 'neg'}` }, `${t.amount > 0 ? '+' : '−'}${money(Math.abs(t.amount))}`),
        h('td', { class: 'num' }, money(t.balanceAfter)))))) : h('p', { class: 'muted' }, 'No transactions yet.'));
    mount(pending, withdrawals.length ? h('ul', { class: 'simple-list' }, withdrawals.map((w) => h('li', null,
      h('div', null, h('strong', null, money(w.amount)), ` to ${w.bank_code} ••••${w.account_last4}`, h('div', { class: 'muted small' }, fmtDateTime(w.created_at), w.note ? ` · ${w.note}` : '')),
      statusPill(w.status)))) : h('p', { class: 'muted' }, 'No withdrawals yet.'));
  };

  // Returning from Paystack checkout
  const ref = query.get('ref');
  if (ref && /^dep_[a-f0-9]{24}$/.test(ref)) {
    history.replaceState(null, '', '#/wallet');
    checkDeposit(ref, refresh);
  }
  currentWalletRefresh = refresh;
  await refresh();
}
let currentWalletRefresh = null;
on('wallet-refresh', () => currentWalletRefresh && currentWalletRefresh().catch(swallow));

async function checkDeposit(ref, refresh, attempt = 0) {
  try {
    const r = await api('POST', `/api/wallet/deposits/${ref}/check`);
    if (r.status === 'success') {
      toast(`Deposit successful: ${money(r.amount)}`, 'success');
      refresh();
    } else if (r.status === 'pending' && attempt < 10) {
      if (attempt === 0) toast('Confirming your payment…', 'info');
      setTimeout(() => checkDeposit(ref, refresh, attempt + 1), 3000);
    } else if (r.status !== 'pending') toast(`Deposit ${r.status}`, 'error');
    else toast('Payment still pending. Your balance will update automatically once confirmed.', 'info');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function depositForm() {
  const cfg = state.config;
  if (!cfg?.payments) return h('p', { class: 'muted' }, 'Online deposits are not available yet.');
  const amt = input({ name: 'amount', inputmode: 'decimal', placeholder: '50.00', required: true });
  const form = h('form', { class: 'stack' },
    field('Amount (GHS)', amt, `Min ${money(cfg.limits.minDeposit)} · Max ${money(cfg.limits.maxDeposit)}`),
    h('div', { class: 'quick-stakes' }, [20, 50, 100, 200].map((n) => h('button', { type: 'button', class: 'chip', onclick: () => { amt.value = n.toFixed(2); } }, `GHS ${n}`))),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Deposit with Paystack'),
    h('p', { class: 'muted small' }, 'Pay securely with Mobile Money or card on Paystack. You will be redirected.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await busy(form.querySelector('[type=submit]'), async () => {
        const r = await api('POST', '/api/wallet/deposits', { amount: amt.value.trim() });
        if (!/^https:\/\/checkout\.paystack\.com\//.test(r.authorizationUrl)) throw new Error('Unexpected payment URL');
        location.assign(r.authorizationUrl);
      });
    } catch { /* toasted */ }
  });
  return form;
}

function withdrawForm() {
  const cfg = state.config;
  if (!state.user) return h('p', null, 'Log in to withdraw.');
  if (cfg?.requireKycForWithdrawal && state.user.kycStatus !== 'verified')
    return h('div', null, h('p', null, 'Your identity must be verified before withdrawing.'), h('p', { class: 'muted small' }, `Verification status: ${state.user.kycStatus}. Contact support with a valid Ghana Card to verify your account.`));
  const method = h('select', { class: 'input', name: 'method' }, h('option', { value: 'mobile_money' }, 'Mobile Money'), h('option', { value: 'ghipss' }, 'Bank account'));
  const bank = h('select', { class: 'input', name: 'bankCode', required: true });
  const loadBanks = async () => {
    mount(bank, h('option', { value: '' }, 'Loading…'));
    try {
      const { banks } = await api('GET', `/api/wallet/banks?type=${method.value}`);
      mount(bank, banks.length ? banks.map((b) => h('option', { value: b.code }, b.name))
        : (method.value === 'mobile_money' ? [['MTN', 'MTN Mobile Money'], ['VOD', 'Telecel Cash'], ['ATL', 'AirtelTigo Money']] : [['', 'Unavailable']]).map(([c, n]) => h('option', { value: c }, n)));
    } catch {
      mount(bank, h('option', { value: '' }, 'Unavailable'));
    }
  };
  method.addEventListener('change', loadBanks);
  loadBanks();
  const form = h('form', { class: 'stack' },
    field('Amount (GHS)', input({ name: 'amount', inputmode: 'decimal', required: true }), cfg ? `Min ${money(cfg.limits.minWithdrawal)}` : null),
    field('Method', method),
    field('Provider / bank', bank),
    field('Account / phone number', input({ name: 'accountNumber', inputmode: 'numeric', required: true, maxlength: 20 })),
    field('Account name', input({ name: 'accountName', required: true, maxlength: 80 }), 'Must match the name registered on the account.'),
    ...reauthFields(),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Request withdrawal'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const vals = formValues(form);
    if (!vals.code) delete vals.code;
    try {
      await busy(form.querySelector('[type=submit]'), async () => {
        await api('POST', '/api/wallet/withdrawals', vals);
        toast('Withdrawal requested. Funds are held while we process it.', 'success');
        form.reset();
        emit('wallet-refresh');
      });
    } catch { /* toasted */ }
  });
  return form;
}

// =================== Account ===================
export async function accountView(root) {
  const u = state.user;
  const twofa = h('div');
  const limits = h('div');
  mount(root, h('div', { class: 'page narrow' },
    h('h1', null, 'Account'),
    h('section', { class: 'card' }, h('h2', null, 'Profile'),
      h('dl', { class: 'kv' }, h('dt', null, 'Name'), h('dd', null, u.displayName), h('dt', null, 'Email'), h('dd', null, u.email),
        h('dt', null, 'Verification'), h('dd', null, statusPill(u.kycStatus)), h('dt', null, 'Member since'), h('dd', null, fmtDateTime(u.createdAt))),
      h('button', { class: 'btn btn-ghost', onclick: (e) => busy(e.target, async () => { await api('POST', '/api/auth/logout-all'); location.hash = '#/login'; location.reload(); }).catch(swallow) }, 'Sign out of all devices')),
    h('section', { class: 'card' }, h('h2', null, 'Two-factor authentication'), twofa),
    h('section', { class: 'card' }, h('h2', null, 'Change password'), passwordForm()),
    h('section', { class: 'card' }, h('h2', null, 'Deposit limits'), h('p', { class: 'muted small' }, 'Lower limits apply immediately. Raising or removing a limit takes effect after 24 hours.'), limits),
    h('section', { class: 'card danger-zone' }, h('h2', null, 'Take a break'), selfExclusion())));
  renderTwoFa(twofa);
  renderLimits(limits);
}

function renderTwoFa(box) {
  if (state.user.totpEnabled) {
    const form = h('form', { class: 'stack' }, h('p', null, '✓ Enabled. You will need your authenticator app to log in.'),
      field('Password', input({ type: 'password', name: 'password', required: true, autocomplete: 'current-password' })),
      field('Authenticator code', input({ name: 'code', inputmode: 'numeric', maxlength: 6, required: true })),
      h('button', { class: 'btn btn-danger', type: 'submit' }, 'Disable 2FA'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await busy(form.querySelector('[type=submit]'), async () => {
          await api('POST', '/api/auth/2fa/disable', formValues(form));
          state.user.totpEnabled = false;
          toast('Two-factor authentication disabled', 'info');
          renderTwoFa(box);
        });
      } catch { /* toasted */ }
    });
    mount(box, form);
    return;
  }
  const start = h('button', { class: 'btn btn-primary' }, 'Set up 2FA');
  start.addEventListener('click', () => busy(start, async () => {
    const { secret, otpauthUrl } = await api('POST', '/api/auth/2fa/setup');
    const code = input({ name: 'code', inputmode: 'numeric', maxlength: 6, required: true });
    const form = h('form', { class: 'stack' },
      h('p', null, 'Add this key to Google Authenticator, Authy or 1Password (choose "enter a setup key"):'),
      h('code', { class: 'secret' }, secret.replace(/(.{4})/g, '$1 ').trim()),
      h('p', { class: 'muted small' }, 'Or open on this device: ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); location.href = otpauthUrl; } }, 'add to authenticator app')),
      field('Enter the 6-digit code to confirm', code),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Enable 2FA'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await busy(form.querySelector('[type=submit]'), async () => {
          await api('POST', '/api/auth/2fa/enable', { code: code.value.trim() });
          state.user.totpEnabled = true;
          toast('Two-factor authentication enabled', 'success');
          renderTwoFa(box);
        });
      } catch { /* toasted */ }
    });
    mount(box, form);
  }).catch(swallow));
  mount(box, h('p', null, 'Protect your account and winnings with an authenticator app.'), start);
}

function passwordForm() {
  const form = h('form', { class: 'stack' },
    field('Current password', input({ type: 'password', name: 'currentPassword', autocomplete: 'current-password', required: true })),
    field('New password', input({ type: 'password', name: 'newPassword', autocomplete: 'new-password', minlength: 10, required: true })),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Update password'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await busy(form.querySelector('[type=submit]'), async () => {
        await api('POST', '/api/auth/password', formValues(form));
        form.reset();
        toast('Password updated. Other devices were signed out.', 'success');
      });
    } catch { /* toasted */ }
  });
  return form;
}

async function renderLimits(box) {
  const { limits } = await api('GET', '/api/account/limits');
  const rows = ['daily', 'weekly', 'monthly'].map((p) => {
    const l = limits[p];
    return field(`${p[0].toUpperCase()}${p.slice(1)} limit (GHS)`,
      input({ name: p, inputmode: 'decimal', placeholder: 'No limit', value: l.amount ? toMajor(l.amount) : '' }),
      l.pending ? `Changing to ${l.pending.amount ? money(l.pending.amount) : 'no limit'} on ${fmtDateTime(l.pending.effectiveAt)}` : null);
  });
  const form = h('form', { class: 'stack' }, rows, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save limits'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const vals = formValues(form);
    for (const k of Object.keys(vals)) if (vals[k].trim() === '') vals[k] = null;
    try {
      await busy(form.querySelector('[type=submit]'), async () => {
        await api('PUT', '/api/account/limits', vals);
        toast('Deposit limits saved', 'success');
        renderLimits(box);
      });
    } catch { /* toasted */ }
  });
  mount(box, form);
}

function selfExclusion() {
  if (state.user.selfExcludedUntil && new Date(state.user.selfExcludedUntil) > new Date())
    return h('p', null, `You are self-excluded until ${fmtDateTime(state.user.selfExcludedUntil)}. You can still log in to withdraw your balance.`);
  const period = h('select', { class: 'input', name: 'period' },
    [['1d', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['180d', '6 months'], ['365d', '1 year'], ['permanent', 'Permanently']].map(([v, l]) => h('option', { value: v }, l)));
  const form = h('form', { class: 'stack' },
    h('p', null, 'Self-exclusion blocks betting and deposits for the period you choose. It cannot be reversed early.'),
    field('Exclude me for', period), ...reauthFields(),
    h('button', { class: 'btn btn-danger', type: 'submit' }, 'Self-exclude'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const vals = formValues(form);
    if (!vals.code) delete vals.code;
    if (!(await confirmDialog('Confirm self-exclusion', 'This cannot be undone until the period ends. Continue?', 'Self-exclude', 'btn-danger'))) return;
    try {
      await busy(form.querySelector('[type=submit]'), async () => {
        await api('POST', '/api/account/self-exclude', vals);
        const { user } = await api('GET', '/api/auth/me');
        state.user = user;
        toast('Self-exclusion is active. Take care.', 'info');
        location.reload();
      });
    } catch { /* toasted */ }
  });
  return form;
}

// =================== Static pages ===================
export function responsibleView(root) {
  mount(root, h('div', { class: 'page narrow prose' },
    h('h1', null, 'Responsible gambling'),
    h('p', null, 'Betting should be entertainment, never a way to make money or escape problems. Only bet what you can afford to lose.'),
    h('h2', null, 'Tools we provide'),
    h('ul', null,
      h('li', null, 'Daily, weekly and monthly deposit limits (Account → Deposit limits).'),
      h('li', null, 'Self-exclusion from 24 hours to permanently (Account → Take a break).'),
      h('li', null, 'A full history of every bet and transaction in your wallet.')),
    h('h2', null, 'Warning signs'),
    h('ul', null, h('li', null, 'Chasing losses or betting more to feel the same excitement.'), h('li', null, 'Borrowing money or using bill money to bet.'), h('li', null, 'Hiding betting from family or friends.')),
    h('p', null, 'If betting is causing you harm, stop, use self-exclusion, and speak to someone you trust or a health professional.'),
    h('p', null, h('strong', null, 'Under 18s are not permitted to open accounts or bet.'))));
}

export function termsView(root) {
  mount(root, h('div', { class: 'page narrow prose' },
    h('h1', null, 'Terms of use'),
    h('p', { class: 'muted' }, 'Operator: replace this page with your licensed terms before going live.'),
    h('ol', null,
      h('li', null, 'You must be 18 or older and legally permitted to bet in your jurisdiction.'),
      h('li', null, 'One account per person. Identity verification is required before withdrawals.'),
      h('li', null, 'Bets are accepted only before an event starts and at the odds confirmed on your bet slip.'),
      h('li', null, 'If an event is cancelled or abandoned, affected selections are void and stakes on single bets are returned; accumulators are recalculated without the void selection.'),
      h('li', null, 'Selections from the same event cannot be combined in one bet.'),
      h('li', null, 'Maximum stake and payout limits apply and are shown on the bet slip.'),
      h('li', null, 'We may suspend accounts involved in fraud, collusion, or abuse, and void bets placed at obviously erroneous odds.'))));
}
