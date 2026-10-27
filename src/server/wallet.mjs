import { config } from './config.mjs';
import { query, tx } from './db.mjs';
import { HttpError, bad, v, fmtMoney } from './http.mjs';
import { requireUser, reauth } from './auth.mjs';
import { rateLimit, getSettings, moveMoney, audit } from './services.mjs';
import { paystack, paystackEnabled, verifyWebhookSignature } from './paystack.mjs';
import { randomId } from './security.mjs';

const PERIODS = { daily: 1, weekly: 7, monthly: 30 };

// ---------- balance & history ----------
export async function wallet(ctx) {
  const u = requireUser(ctx);
  const { rows } = await query('SELECT balance, currency FROM wallets WHERE user_id = $1', [u.id]);
  const pend = await query("SELECT coalesce(sum(amount),0)::bigint AS s FROM withdrawals WHERE user_id = $1 AND status IN ('pending','processing')", [u.id]);
  const open = await query("SELECT coalesce(sum(stake),0)::bigint AS s, count(*)::int AS n FROM bets WHERE user_id = $1 AND status = 'open'", [u.id]);
  return {
    balance: rows[0]?.balance ?? 0,
    currency: rows[0]?.currency ?? config.currency,
    pendingWithdrawals: pend.rows[0].s,
    openStakes: open.rows[0].s,
    openBets: open.rows[0].n,
  };
}

export async function transactions(ctx) {
  const u = requireUser(ctx);
  const before = ctx.url.searchParams.get('before') ? v.id(ctx.url.searchParams.get('before'), 'before') : null;
  const { rows } = await query(
    `SELECT id, amount, balance_after, kind, ref_type, ref_id, description, created_at
       FROM ledger_entries WHERE user_id = $1 ${before ? 'AND id < $2' : ''} ORDER BY id DESC LIMIT 50`,
    before ? [u.id, before] : [u.id]
  );
  return { transactions: rows.map((r) => ({ id: r.id, amount: r.amount, balanceAfter: r.balance_after, kind: r.kind, ref: `${r.ref_type}:${r.ref_id}`, description: r.description, createdAt: r.created_at })) };
}

// ---------- responsible gambling: deposit limits ----------
async function effectiveLimits(db, userId) {
  // Promote pending increases whose 24h cooling-off has elapsed.
  await db.query(
    `UPDATE deposit_limits SET amount = CASE WHEN pending_clear THEN NULL ELSE pending_amount END,
        pending_amount = NULL, pending_clear = FALSE, pending_effective_at = NULL, updated_at = now()
      WHERE user_id = $1 AND pending_effective_at IS NOT NULL AND pending_effective_at <= now()`,
    [userId]
  );
  const { rows } = await db.query('SELECT * FROM deposit_limits WHERE user_id = $1', [userId]);
  const out = {};
  for (const p of Object.keys(PERIODS)) {
    const r = rows.find((x) => x.period === p);
    out[p] = {
      amount: r?.amount ?? null,
      pending: r?.pending_effective_at ? { amount: r.pending_clear ? null : r.pending_amount, effectiveAt: r.pending_effective_at } : null,
    };
  }
  return out;
}

export async function getLimits(ctx) {
  const u = requireUser(ctx);
  return { limits: await effectiveLimits({ query }, u.id) };
}

export async function setLimits(ctx) {
  const u = requireUser(ctx);
  const b = v.obj(ctx.body);
  return tx(async (db) => {
    const cur = await effectiveLimits(db, u.id);
    for (const p of Object.keys(PERIODS)) {
      if (!(p in b)) continue;
      const next = b[p] === null || b[p] === '' ? null : v.money(b[p], `${p} limit`);
      const now = cur[p].amount;
      if (next === now) continue;
      const tighter = now === null ? next !== null : next !== null && next < now;
      if (tighter) {
        await db.query(
          `INSERT INTO deposit_limits(user_id, period, amount) VALUES ($1,$2,$3)
           ON CONFLICT (user_id, period) DO UPDATE SET amount = $3, pending_amount = NULL, pending_clear = FALSE, pending_effective_at = NULL, updated_at = now()`,
          [u.id, p, next]
        );
      } else {
        // Loosening a limit only takes effect after a 24 hour cooling-off period.
        await db.query(
          `INSERT INTO deposit_limits(user_id, period, amount, pending_amount, pending_clear, pending_effective_at)
           VALUES ($1,$2,$3,$4,$5, now() + interval '24 hours')
           ON CONFLICT (user_id, period) DO UPDATE SET pending_amount = $4, pending_clear = $5, pending_effective_at = now() + interval '24 hours', updated_at = now()`,
          [u.id, p, now, next, next === null]
        );
      }
    }
    await audit(db, { actorId: u.id, action: 'rg.limits_changed', targetType: 'user', targetId: u.id, details: b, ip: ctx.ip });
    return { limits: await effectiveLimits(db, u.id) };
  });
}

export async function selfExclude(ctx) {
  const u = requireUser(ctx);
  const b = v.obj(ctx.body);
  const period = v.oneOf(b.period, 'period', ['1d', '7d', '30d', '180d', '365d', 'permanent']);
  await reauth(ctx, b);
  const days = { '1d': 1, '7d': 7, '30d': 30, '180d': 180, '365d': 365, permanent: 365 * 100 }[period];
  await tx(async (db) => {
    await db.query(
      `UPDATE users SET self_excluded_until = GREATEST(coalesce(self_excluded_until, now()), now() + make_interval(days => $2)), updated_at = now() WHERE id = $1`,
      [u.id, days]
    );
    await audit(db, { actorId: u.id, action: 'rg.self_excluded', targetType: 'user', targetId: u.id, details: { period }, ip: ctx.ip });
  });
  return { ok: true };
}

// ---------- deposits (Paystack) ----------
export async function startDeposit(ctx) {
  const u = requireUser(ctx);
  await rateLimit(`deposit:${u.id}`, 10, 600);
  const settings = await getSettings();
  if (!settings.depositsEnabled) throw new HttpError(503, 'DEPOSITS_DISABLED', 'Deposits are temporarily unavailable');
  if (!paystackEnabled()) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not configured');
  if (u.self_excluded_until && new Date(u.self_excluded_until) > new Date())
    throw new HttpError(403, 'SELF_EXCLUDED', 'Deposits are blocked while you are self-excluded');
  const amount = v.money(v.obj(ctx.body).amount, 'Amount');
  if (amount < settings.minDeposit) throw bad(`Minimum deposit is GHS ${fmtMoney(settings.minDeposit)}`);
  if (amount > settings.maxDeposit) throw bad(`Maximum deposit is GHS ${fmtMoney(settings.maxDeposit)}`);

  const reference = randomId('dep');
  await tx(async (db) => {
    await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [u.id]); // serialize limit checks per user
    const limits = await effectiveLimits(db, u.id);
    for (const [p, days] of Object.entries(PERIODS)) {
      const lim = limits[p].amount;
      if (lim === null) continue;
      const { rows } = await db.query(
        `SELECT coalesce(sum(amount),0)::bigint AS s FROM deposits
          WHERE user_id = $1 AND created_at > now() - make_interval(days => $2)
            AND (status = 'success' OR (status = 'pending' AND created_at > now() - interval '1 hour'))`,
        [u.id, days]
      );
      if (rows[0].s + amount > lim)
        throw bad(`This deposit would exceed your ${p} deposit limit of GHS ${fmtMoney(lim)}`, 'DEPOSIT_LIMIT');
    }
    await db.query('INSERT INTO deposits(user_id, reference, amount) VALUES ($1,$2,$3)', [u.id, reference, amount]);
  });

  const data = await paystack('POST', '/transaction/initialize', {
    email: u.email,
    amount,
    currency: config.currency,
    reference,
    callback_url: `${config.siteUrl}/#/wallet?ref=${reference}`,
    metadata: { user_id: String(u.id), cancel_action: `${config.siteUrl}/#/wallet` },
  }).catch(async (e) => {
    await query("UPDATE deposits SET status = 'failed', completed_at = now() WHERE reference = $1", [reference]);
    throw e;
  });
  return { reference, authorizationUrl: data.authorization_url };
}

/** Credit a deposit after confirming it with Paystack. Fully idempotent. */
export async function confirmDeposit(reference, { source }) {
  const verified = await paystack('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  return tx(async (db) => {
    const dep = (await db.query('SELECT * FROM deposits WHERE reference = $1 FOR UPDATE', [reference])).rows[0];
    if (!dep) throw new HttpError(404, 'NOT_FOUND', 'Deposit not found');
    if (dep.status === 'success') return { status: 'success', amount: dep.amount, alreadyCredited: true };
    if (verified.status !== 'success') {
      if (['failed', 'abandoned', 'reversed'].includes(verified.status)) {
        const st = verified.status === 'abandoned' ? 'abandoned' : 'failed';
        await db.query('UPDATE deposits SET status = $2, provider_data = $3, completed_at = now() WHERE id = $1', [dep.id, st, JSON.stringify({ status: verified.status, gateway_response: verified.gateway_response })]);
        return { status: st };
      }
      return { status: 'pending' };
    }
    // Defend against amount/currency tampering: the provider-confirmed values must match what we issued.
    if (Number(verified.amount) !== dep.amount || verified.currency !== dep.currency || verified.reference !== dep.reference) {
      await db.query('UPDATE deposits SET status = $2, provider_data = $3 WHERE id = $1', [dep.id, 'failed', JSON.stringify({ mismatch: true, amount: verified.amount, currency: verified.currency })]);
      await audit(db, { action: 'deposit.mismatch', targetType: 'deposit', targetId: dep.reference, details: { expected: dep.amount, got: verified.amount, currency: verified.currency } });
      return { status: 'failed' };
    }
    await db.query(
      `UPDATE deposits SET status = 'success', channel = $2, provider_data = $3, completed_at = now() WHERE id = $1`,
      [dep.id, verified.channel || null, JSON.stringify({ id: verified.id, channel: verified.channel, paid_at: verified.paid_at, source })]
    );
    await moveMoney(db, { userId: dep.user_id, amount: dep.amount, kind: 'deposit', refType: 'deposit', refId: dep.reference, description: `Deposit via ${verified.channel || 'Paystack'}` });
    return { status: 'success', amount: dep.amount };
  });
}

export async function checkDeposit(ctx) {
  const u = requireUser(ctx);
  await rateLimit(`depcheck:${u.id}`, 30, 300);
  const reference = v.str(ctx.params.reference, 'reference', { max: 64, pattern: /^dep_[a-f0-9]{24}$/ });
  const own = await query('SELECT status FROM deposits WHERE reference = $1 AND user_id = $2', [reference, u.id]);
  if (!own.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Deposit not found');
  if (own.rows[0].status !== 'pending') return { status: own.rows[0].status };
  return confirmDeposit(reference, { source: 'user_check' });
}

export async function myDeposits(ctx) {
  const u = requireUser(ctx);
  const { rows } = await query('SELECT reference, amount, status, channel, created_at, completed_at FROM deposits WHERE user_id = $1 ORDER BY id DESC LIMIT 30', [u.id]);
  return { deposits: rows };
}

// ---------- withdrawals ----------
let bankCache = {};
export async function banks(ctx) {
  requireUser(ctx);
  const type = v.oneOf(ctx.url.searchParams.get('type') || 'mobile_money', 'type', ['mobile_money', 'ghipss']);
  if (!paystackEnabled()) return { banks: [] };
  const c = bankCache[type];
  if (c && Date.now() - c.at < 6 * 3600_000) return { banks: c.list };
  const data = await paystack('GET', `/bank?currency=GHS&type=${type}&perPage=100`);
  const list = data.filter((x) => x.active !== false).map((x) => ({ code: x.code, name: x.name }));
  bankCache[type] = { at: Date.now(), list };
  return { banks: list };
}

export async function requestWithdrawal(ctx) {
  const u = requireUser(ctx);
  await rateLimit(`withdraw:${u.id}`, 5, 3600);
  const settings = await getSettings();
  if (!settings.withdrawalsEnabled) throw new HttpError(503, 'WITHDRAWALS_DISABLED', 'Withdrawals are temporarily unavailable');
  const b = v.obj(ctx.body);
  const amount = v.money(b.amount, 'Amount');
  const method = v.oneOf(b.method, 'Method', ['mobile_money', 'ghipss']);
  const bankCode = v.str(b.bankCode, 'Provider', { max: 20, pattern: /^[A-Za-z0-9]+$/ });
  const accountNumber = v.str(b.accountNumber, 'Account number', { min: 6, max: 20, pattern: /^[0-9]+$/ });
  const accountName = v.str(b.accountName, 'Account name', { min: 2, max: 80, pattern: /^[\p{L} .'-]+$/u });
  if (amount < settings.minWithdrawal) throw bad(`Minimum withdrawal is GHS ${fmtMoney(settings.minWithdrawal)}`);
  if (amount > settings.maxWithdrawal) throw bad(`Maximum withdrawal is GHS ${fmtMoney(settings.maxWithdrawal)}`);
  if (settings.requireKycForWithdrawal && u.kyc_status !== 'verified')
    throw new HttpError(403, 'KYC_REQUIRED', 'Your identity must be verified before you can withdraw. Contact support.');
  await reauth(ctx, b);

  const reference = randomId('wd');
  return tx(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO withdrawals(user_id, reference, amount, method, bank_code, account_number, account_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, reference, amount, status, created_at`,
      [u.id, reference, amount, method, bankCode, accountNumber, accountName]
    );
    // Funds are debited immediately (held) and returned if the withdrawal is rejected or fails.
    const balance = await moveMoney(db, { userId: u.id, amount: -amount, kind: 'withdrawal', refType: 'withdrawal', refId: reference, description: 'Withdrawal requested' });
    await audit(db, { actorId: u.id, action: 'withdrawal.requested', targetType: 'withdrawal', targetId: reference, details: { amount }, ip: ctx.ip });
    return { withdrawal: rows[0], balance };
  });
}

export async function myWithdrawals(ctx) {
  const u = requireUser(ctx);
  const { rows } = await query(
    `SELECT reference, amount, method, bank_code, right(account_number, 4) AS account_last4, status, note, created_at, updated_at
       FROM withdrawals WHERE user_id = $1 ORDER BY id DESC LIMIT 30`,
    [u.id]
  );
  return { withdrawals: rows };
}

/** Return held funds for a withdrawal that will not be paid. Must be in tx with the row locked. */
export async function reverseWithdrawal(db, w, { status, note, actorId = null }) {
  await db.query('UPDATE withdrawals SET status = $2, note = $3, reviewed_by = coalesce($4, reviewed_by), reviewed_at = coalesce(reviewed_at, now()), updated_at = now() WHERE id = $1', [w.id, status, note, actorId]);
  await moveMoney(db, { userId: w.user_id, amount: w.amount, kind: 'withdrawal_reversal', refType: 'withdrawal', refId: w.reference, description: `Withdrawal ${status}${note ? `: ${note}` : ''}`, createdBy: actorId });
}

// ---------- Paystack webhook ----------
export async function paystackWebhook(ctx) {
  const allow = config.paystackIpAllowlist;
  if (allow && !allow.includes(ctx.ip)) throw new HttpError(403, 'FORBIDDEN', 'Forbidden');
  if (!verifyWebhookSignature(ctx.rawBody, ctx.req.headers.get('x-paystack-signature')))
    throw new HttpError(401, 'BAD_SIGNATURE', 'Invalid signature');
  let evt;
  try {
    evt = JSON.parse(ctx.rawBody);
  } catch {
    throw bad('Invalid JSON');
  }
  const type = String(evt.event || '');
  const ref = String(evt.data?.reference || '');
  const dedupe = `${type}:${ref}:${evt.data?.id ?? ''}:${evt.data?.status ?? ''}`;
  const ins = await query(
    `INSERT INTO webhook_events(provider, dedupe_key, event_type, payload) VALUES ('paystack',$1,$2,$3)
     ON CONFLICT (provider, dedupe_key) DO NOTHING RETURNING id`,
    [dedupe, type, ctx.rawBody]
  );
  const firstTime = ins.rowCount > 0;
  const rowId = ins.rows[0]?.id;
  try {
    if (type === 'charge.success' && /^dep_[a-f0-9]{24}$/.test(ref)) {
      await confirmDeposit(ref, { source: 'webhook' });
    } else if (['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(type) && /^wd_[a-f0-9]{24}$/.test(ref)) {
      await refreshWithdrawal(ref, { source: 'webhook' });
    }
    if (rowId) await query('UPDATE webhook_events SET processed_at = now() WHERE id = $1', [rowId]);
  } catch (e) {
    if (rowId) await query('UPDATE webhook_events SET error = $2 WHERE id = $1', [rowId, String(e.message).slice(0, 500)]);
    // Non-2xx makes Paystack retry later, which is what we want for transient failures.
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
  }
  return { ok: true, duplicate: !firstTime };
}

/** Re-check a transfer with Paystack and finalize the withdrawal accordingly. */
export async function refreshWithdrawal(reference, { source, actorId = null } = {}) {
  const t = await paystack('GET', `/transfer/verify/${encodeURIComponent(reference)}`);
  return tx(async (db) => {
    const w = (await db.query('SELECT * FROM withdrawals WHERE reference = $1 FOR UPDATE', [reference])).rows[0];
    if (!w) throw new HttpError(404, 'NOT_FOUND', 'Withdrawal not found');
    if (w.status !== 'processing') return { status: w.status };
    if (t.status === 'success') {
      await db.query("UPDATE withdrawals SET status = 'paid', transfer_code = coalesce(transfer_code, $2), updated_at = now() WHERE id = $1", [w.id, t.transfer_code || null]);
      await audit(db, { actorId, action: 'withdrawal.paid', targetType: 'withdrawal', targetId: reference, details: { source } });
      return { status: 'paid' };
    }
    if (['failed', 'reversed', 'rejected', 'abandoned'].includes(t.status)) {
      await reverseWithdrawal(db, w, { status: 'failed', note: `Transfer ${t.status}`, actorId });
      await audit(db, { actorId, action: 'withdrawal.failed', targetType: 'withdrawal', targetId: reference, details: { source, providerStatus: t.status } });
      return { status: 'failed' };
    }
    return { status: 'processing', providerStatus: t.status };
  });
}
