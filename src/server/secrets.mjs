import crypto from 'node:crypto';
import { config } from './config.mjs';

// The app secret (used to encrypt 2FA secrets at rest) comes from APP_SECRET when
// set. Otherwise, on Netlify, a random 384-bit key is generated once and kept in
// Netlify Blobs: a store separate from the database, so a database leak alone does
// not expose the key.
let cached = null;
let loading = null;

export function appSecret() {
  return config.appSecret || cached || '';
}

export async function ensureAppSecret() {
  if (config.appSecret || cached) return appSecret();
  loading ??= (async () => {
    let store;
    try {
      const { getStore } = await import('@netlify/blobs');
      store = getStore({ name: 'kickline-secrets', consistency: 'strong' });
    } catch (e) {
      console.error('[secrets] Netlify Blobs unavailable:', e.message);
      return '';
    }
    let value = await store.get('app-secret');
    if (!value) {
      const fresh = crypto.randomBytes(48).toString('base64url');
      try {
        await store.set('app-secret', fresh, { onlyIfNew: true });
      } catch (e) {
        console.error('[secrets] could not store app secret:', e.message);
      }
      value = await store.get('app-secret'); // read back the winner if two instances raced
    }
    if (value && value.length >= 32) cached = value;
    return appSecret();
  })().finally(() => {
    loading = null;
  });
  return loading;
}
