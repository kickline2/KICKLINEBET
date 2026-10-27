// Core utilities: safe DOM builder (never uses innerHTML), API client, formatting, state.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, val] of Object.entries(attrs)) {
      if (val === undefined || val === null || val === false) continue;
      if (k === 'class') el.className = val;
      else if (k === 'dataset') Object.assign(el.dataset, val);
      else if (k.startsWith('on') && typeof val === 'function') el.addEventListener(k.slice(2), val);
      else if (k === 'value') el.value = val;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = Boolean(val);
      else if (k === 'href') {
        const s = String(val);
        if (/^(#|\/|https:\/\/)/.test(s)) el.setAttribute('href', s); // block javascript: URLs
      } else el.setAttribute(k, val === true ? '' : String(val));
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}
export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};
export const mount = (el, ...children) => {
  clear(el);
  append(el, children);
  return el;
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code || 'ERROR';
    this.data = body?.error || {};
  }
}

export async function api(method, path, body) {
  const opts = { method, headers: { 'x-requested-with': 'kickline' }, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError(0, { error: { code: 'NETWORK', message: 'Network error. Check your connection.' } });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && err.code === 'UNAUTHENTICATED') {
      state.user = null;
      emit('auth');
    }
    throw err;
  }
  return data;
}

export const money = (minor) =>
  `GHS ${(Number(minor || 0) / 100).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const toMajor = (minor) => (Number(minor || 0) / 100).toFixed(2);
export const fmtDate = (d) =>
  new Date(d).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString() : '—');

export function newIdempotencyKey() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- state & events ----------
export const state = { user: null, config: null, wallet: null, slip: loadSlip() };
const listeners = {};
export const on = (evt, fn) => (listeners[evt] ||= []).push(fn);
export const emit = (evt, data) => (listeners[evt] || []).forEach((fn) => fn(data));

function loadSlip() {
  try {
    const raw = JSON.parse(localStorage.getItem('kl_slip') || '[]');
    return Array.isArray(raw) ? raw.filter((s) => s && Number.isInteger(s.selectionId)).slice(0, 50) : [];
  } catch {
    return [];
  }
}
export function saveSlip() {
  try {
    localStorage.setItem('kl_slip', JSON.stringify(state.slip));
  } catch {
    /* storage unavailable */
  }
  emit('slip');
}

export async function refreshWallet() {
  if (!state.user) {
    state.wallet = null;
  } else {
    try {
      state.wallet = await api('GET', '/api/wallet');
    } catch {
      /* ignore */
    }
  }
  emit('wallet');
}

// ---------- toasts & dialogs ----------
export function toast(message, kind = 'info') {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  box.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, kind === 'error' ? 6000 : 3500);
}

export function modal(title, body, actions = []) {
  return new Promise((resolve) => {
    const close = (v) => {
      overlay.remove();
      document.removeEventListener('keydown', esc);
      resolve(v);
    };
    const esc = (e) => e.key === 'Escape' && close(null);
    const overlay = h('div', { class: 'modal-overlay', onclick: (e) => e.target === overlay && close(null) },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'modal-head' }, h('h3', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(null) }, '×')),
        h('div', { class: 'modal-body' }, body),
        actions.length ? h('div', { class: 'modal-actions' }, actions.map((a) =>
          h('button', { class: `btn ${a.class || ''}`, onclick: async () => {
            if (a.handler) {
              const r = await a.handler();
              if (r === false) return;
              close(r ?? a.value);
            } else close(a.value);
          } }, a.label))) : null));
    document.body.appendChild(overlay);
    document.addEventListener('keydown', esc);
    overlay.querySelector('input,select,textarea,button.btn-primary')?.focus();
  });
}

export const confirmDialog = (title, text, label = 'Confirm', cls = 'btn-primary') =>
  modal(title, h('p', null, text), [{ label: 'Cancel', value: false }, { label, value: true, class: cls }]);

/** Form helpers */
export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
}
export const input = (attrs) => h('input', { class: 'input', ...attrs });
export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}
/** Run an async action with a busy button and error toast. */
export async function busy(btn, fn) {
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    return await fn();
  } catch (e) {
    toast(e.message || 'Something went wrong', 'error');
    throw e;
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = label;
  }
}
export const swallow = () => {};

export function statusPill(status) {
  return h('span', { class: `pill pill-${status}` }, status.replace(/_/g, ' '));
}

/** Password + optional 2FA prompt used for sensitive actions. */
export function reauthFields() {
  return [
    field('Password', input({ type: 'password', name: 'password', autocomplete: 'current-password', required: true })),
    state.user?.totpEnabled
      ? field('Authenticator code', input({ name: 'code', inputmode: 'numeric', pattern: '[0-9]{6}', maxlength: 6, autocomplete: 'one-time-code', required: true }))
      : null,
  ];
}
