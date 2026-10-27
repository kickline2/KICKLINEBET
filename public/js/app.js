import { h, mount, api, money, state, on, emit, refreshWallet, toast, swallow } from './core.js';
import {
  sportsbookView, renderSlip, loginView, registerView, betsView, walletView, accountView, responsibleView, termsView,
} from './views.js';
import { adminRouter } from './admin.js';

const main = document.getElementById('main');
const nav = document.getElementById('nav');
let cleanup = null;

function renderNav() {
  const u = state.user;
  const w = state.wallet;
  mount(nav,
    h('a', { href: '#/', class: 'nav-link' }, 'Sports'),
    u ? h('a', { href: '#/bets', class: 'nav-link' }, 'My bets') : null,
    u?.role === 'admin' ? h('a', { href: '#/admin', class: 'nav-link' }, 'Admin') : null,
    h('span', { class: 'spacer' }),
    u
      ? [
          h('a', { href: '#/wallet', class: 'balance-chip', title: 'Wallet' }, w ? money(w.balance) : '…'),
          h('a', { href: '#/wallet', class: 'btn btn-primary btn-sm' }, 'Deposit'),
          h('a', { href: '#/account', class: 'nav-link', 'aria-label': 'Account' }, u.displayName),
          h('button', { class: 'nav-link link-btn', onclick: logout }, 'Log out'),
        ]
      : [h('a', { href: '#/login', class: 'btn btn-ghost btn-sm' }, 'Log in'), h('a', { href: '#/register', class: 'btn btn-primary btn-sm' }, 'Join')]);
  const count = document.getElementById('slip-count');
  count.textContent = String(state.slip.length);
}

async function logout() {
  try {
    await api('POST', '/api/auth/logout');
  } catch { /* ignore */ }
  state.user = null;
  state.wallet = null;
  emit('auth');
  location.hash = '#/';
}

const PROTECTED = new Set(['bets', 'wallet', 'account', 'admin']);

async function route() {
  if (cleanup) {
    try { cleanup(); } catch { /* ignore */ }
    cleanup = null;
  }
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, qs = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const query = new URLSearchParams(qs);
  const top = parts[0] || '';
  document.body.classList.remove('slip-open');
  document.body.classList.toggle('is-admin', top === 'admin');
  if (PROTECTED.has(top) && !state.user) {
    location.hash = '#/login';
    return;
  }
  window.scrollTo(0, 0);
  if (state.user) refreshWallet().catch(swallow);
  try {
    switch (top) {
      case '': cleanup = await sportsbookView(main, {}); break;
      case 'sport': cleanup = await sportsbookView(main, { sport: parts[1] }); break;
      case 'login': state.user ? (location.hash = '#/') : loginView(main); break;
      case 'register': state.user ? (location.hash = '#/') : registerView(main); break;
      case 'bets': await betsView(main); break;
      case 'wallet': await walletView(main, {}, query); break;
      case 'account': await accountView(main); break;
      case 'responsible': responsibleView(main); break;
      case 'terms': termsView(main); break;
      case 'admin': await adminRouter(main, parts[1] || '', { id: parts[2] }); break;
      default: mount(main, h('div', { class: 'page' }, h('h1', null, 'Not found'), h('a', { href: '#/' }, 'Back to sports')));
    }
  } catch (e) {
    mount(main, h('div', { class: 'page' }, h('div', { class: 'alert' }, e.message || 'Failed to load'), h('button', { class: 'btn btn-ghost', onclick: route }, 'Retry')));
  }
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${top}` || (top === '' && a.getAttribute('href') === '#/')));
}

async function boot() {
  document.getElementById('slip-toggle').addEventListener('click', () => document.body.classList.toggle('slip-open'));
  document.getElementById('slip-close').addEventListener('click', () => document.body.classList.remove('slip-open'));
  try {
    const [cfg, me] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/auth/me')]);
    state.config = cfg;
    state.user = me.user;
    if (!cfg.bettingEnabled) document.getElementById('banner').hidden = false;
  } catch (e) {
    toast(`Could not reach the server: ${e.message}`, 'error');
  }
  on('auth', renderNav);
  on('wallet', renderNav);
  on('slip', renderNav);
  on('auth', () => { if (!state.user && PROTECTED.has((location.hash.split('/')[1] || '').split('?')[0])) location.hash = '#/login'; });
  renderSlip(document.getElementById('slip-body'));
  renderNav();
  await refreshWallet();
  window.addEventListener('hashchange', route);
  await route();
  // Keep the balance fresh (bets settle in the background).
  setInterval(() => { if (state.user && document.visibilityState === 'visible') refreshWallet().catch(swallow); }, 60_000);
}

boot();
