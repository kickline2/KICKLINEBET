import crypto from 'node:crypto';
import { config } from './config.mjs';
import { HttpError } from './http.mjs';
import { safeEqual } from './security.mjs';

const BASE = 'https://api.paystack.co';

export const paystackEnabled = () => Boolean(config.paystackSecret);

export async function paystack(method, path, body) {
  if (!paystackEnabled()) throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.paystackSecret}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    console.error('[paystack] network error', path, e.message);
    throw new HttpError(502, 'PAYMENT_PROVIDER_ERROR', 'Payment provider is unreachable. Please try again.');
  } finally {
    clearTimeout(t);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok || !data || data.status !== true) {
    console.error('[paystack] error', path, res.status, data?.message);
    const err = new HttpError(502, 'PAYMENT_PROVIDER_ERROR', data?.message ? `Payment provider: ${data.message}` : 'Payment provider error');
    err.providerStatus = res.status;
    throw err;
  }
  return data.data;
}

/** Verify x-paystack-signature: HMAC-SHA512 of the raw body with the secret key. */
export function verifyWebhookSignature(rawBody, signature) {
  if (!config.paystackSecret || !signature) return false;
  const expected = crypto.createHmac('sha512', config.paystackSecret).update(rawBody).digest('hex');
  return safeEqual(expected, String(signature).toLowerCase());
}
