import { syncOdds } from '../../src/server/odds.mjs';
import { maintenance } from '../../src/server/services.mjs';

// Runs every 15 minutes: housekeeping + odds feed. syncOdds() throttles itself to
// ODDS_SYNC_INTERVAL_MINUTES so you control API-credit usage with an env var.
export default async () => {
  try {
    await maintenance();
  } catch (e) {
    console.error('[scheduled] maintenance failed', e);
  }
  try {
    const r = await syncOdds();
    console.log('[scheduled] odds', JSON.stringify(r));
  } catch (e) {
    console.error('[scheduled] odds sync failed', e);
  }
  return new Response('ok');
};

export const config = { schedule: '*/15 * * * *' };
