// Central configuration. Every value comes from environment variables so that
// secrets never live in the repository.

const env = (k, d) => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};
const int = (k, d) => {
  const n = Number.parseInt(env(k, ''), 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (k, d) => {
  const v = env(k, '');
  if (v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

export const config = {
  get databaseUrl() {
    return env('DATABASE_URL', env('NETLIFY_DATABASE_URL', ''));
  },
  get appSecret() {
    return env('APP_SECRET', '');
  },
  get production() {
    return env('CONTEXT', env('NODE_ENV', '')) === 'production';
  },
  // Public base URL of the site, used for Paystack callbacks and Origin checks.
  get siteUrl() {
    return env('SITE_URL', env('URL', 'http://localhost:8888')).replace(/\/+$/, '');
  },
  get insecureCookies() {
    return bool('INSECURE_COOKIES', false); // only for local http development
  },
  currency: 'GHS',
  get sessionTtlHours() {
    return int('SESSION_TTL_HOURS', 24 * 7);
  },
  get sessionIdleMinutes() {
    return int('SESSION_IDLE_MINUTES', 60 * 12);
  },
  get adminEmails() {
    return env('ADMIN_EMAILS', '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  },
  get requireAdmin2fa() {
    return bool('REQUIRE_ADMIN_2FA', true);
  },

  // Paystack
  get paystackSecret() {
    return env('PAYSTACK_SECRET_KEY', '');
  },
  get paystackPublic() {
    return env('PAYSTACK_PUBLIC_KEY', '');
  },
  get paystackTransfersEnabled() {
    return bool('PAYSTACK_TRANSFERS_ENABLED', false);
  },
  get paystackIpAllowlist() {
    // Paystack publishes its webhook source IPs. Enforced only when enabled.
    return bool('PAYSTACK_ENFORCE_IPS', false)
      ? ['52.31.139.75', '52.49.173.169', '52.214.14.220']
      : null;
  },

  // The Odds API
  get oddsApiKey() {
    return env('ODDS_API_KEY', '');
  },
  get oddsApiSports() {
    return env('ODDS_API_SPORTS', 'soccer_epl,soccer_uefa_champs_league')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  },
  get oddsApiRegions() {
    return env('ODDS_API_REGIONS', 'uk,eu');
  },
  get oddsMargin() {
    const m = Number(env('ODDS_MARGIN', '0.05'));
    return Number.isFinite(m) && m >= 0 && m < 0.5 ? m : 0.05;
  },
  get oddsAutoSettle() {
    return bool('ODDS_AUTO_SETTLE', true);
  },
  get oddsSyncIntervalMinutes() {
    return int('ODDS_SYNC_INTERVAL_MINUTES', 60);
  },
};

// Betting/wallet limits. Admin can override any of these at runtime via the
// settings table; these are the defaults. All money is in minor units (pesewas).
export const DEFAULT_SETTINGS = Object.freeze({
  minStake: 100, // GHS 1.00
  maxStake: 500000, // GHS 5,000.00
  maxPayout: 5000000, // GHS 50,000.00
  maxLegs: 20,
  minDeposit: 500, // GHS 5.00
  maxDeposit: 2000000, // GHS 20,000.00
  minWithdrawal: 1000, // GHS 10.00
  maxWithdrawal: 2000000,
  requireKycForWithdrawal: true,
  bettingEnabled: true,
  depositsEnabled: true,
  withdrawalsEnabled: true,
  minOdds: 1010, // 1.01 (odds are stored as integer thousandths)
  maxOdds: 1000000, // 1000.00
});

export function assertProductionConfig() {
  const problems = [];
  if (!config.databaseUrl) problems.push('DATABASE_URL / NETLIFY_DATABASE_URL is not set');
  if (!config.appSecret || config.appSecret.length < 32)
    problems.push('APP_SECRET must be set to a random string of at least 32 characters');
  return problems;
}
