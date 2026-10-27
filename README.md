# Kickline Sportsbook

A production-grade sports betting platform for Netlify: real accounts, a Postgres-backed wallet ledger, atomic bet placement, settlement, Paystack deposits/withdrawals (Mobile Money + cards, GHS), an odds feed from The Odds API, responsible-gambling tools, and a 2FA-protected admin back office.

> **Legal:** operating real-money betting in Ghana requires a licence from the Gaming Commission of Ghana (and KYC/AML procedures). Run Paystack in **test mode** until you are licensed. Replace the placeholder Terms page with your licensed terms.

## Architecture

```
public/                 Static frontend (vanilla JS modules, strict CSP, no inline scripts, no innerHTML)
netlify/functions/
  api.mjs               All /api/* routes (one function, internal router)
  odds-sync.mjs         Scheduled every 15 min: housekeeping + odds feed + auto-settlement
src/server/
  app.mjs               Router, CSRF/origin checks, body limits, error handling
  auth.mjs              Register/login, sessions, lockout, TOTP 2FA, re-auth
  betting.mjs           Events, bet placement, exact BigInt odds math, settlement/grading
  wallet.mjs            Balance, ledger, deposits, withdrawals, limits, self-exclusion, webhook
  admin.mjs             Back-office endpoints (all audited)
  odds.mjs              The Odds API import + score-based settlement
  paystack.mjs          Paystack client + webhook signature check
  security.mjs          scrypt, tokens, AES-GCM, TOTP
  schema.mjs            Versioned migrations (auto-applied, advisory-locked)
tests/                  Integration tests against real Postgres
```

## Security & integrity measures

- **Money is integers** (pesewas) stored as BIGINT; odds stored as integer thousandths; payouts computed with BigInt, never floats.
- **Double-entry style ledger**: every balance change writes a `ledger_entries` row in the same transaction; a unique index on `(kind, ref_type, ref_id)` makes it impossible to pay a bet, credit a deposit, or refund a withdrawal twice. `CHECK (balance >= 0)` at the database level.
- **No double spend**: balance debits are a single conditional `UPDATE … WHERE balance + amount >= 0`; tested with 12 concurrent bets.
- **Bets are validated server-side** under row locks: market open, event not started, odds match what the user saw (or user opted to accept higher), no same-event combinations, stake/payout caps. **Idempotency keys** prevent duplicate bets on retries.
- **Deposits are only credited after server-side verification with Paystack**, matching amount, currency and reference. Webhooks require a valid HMAC-SHA512 signature (optional IP allowlist), are deduplicated and safe to replay.
- **Withdrawals** require identity verification (KYC flag), password + 2FA re-authentication; funds are held immediately and returned automatically on rejection/failure.
- **Auth**: scrypt password hashing, common-password checks, constant-time comparisons, timing-safe unknown-user path, account lockout after 5 failures, DB-backed rate limits.
- **Sessions**: random 256-bit tokens stored as SHA-256 hashes, `__Host-` cookie with `HttpOnly; Secure; SameSite=Strict`, absolute + idle expiry, revocation on logout/password change, "sign out everywhere".
- **CSRF**: SameSite=Strict + Origin/Referer check + required custom header on all writes.
- **2FA (TOTP)** with replay protection; secrets encrypted at rest (AES-256-GCM). **Admins must enable 2FA** to use any admin tool. Balance adjustments and payouts require password + code.
- **Full audit log** of admin actions, logins, limit changes, settlement.
- **Headers**: strict CSP, HSTS, frame-ancestors none, nosniff, COOP, Permissions-Policy. Frontend builds DOM with `textContent` only (no XSS sinks).
- **Responsible gambling**: 18+ age check at sign-up, deposit limits (decreases instant, increases after 24 h cooling-off), self-exclusion (24 h → permanent), cannot be lifted early.

## Deploy to Netlify

Netlify's drag-and-drop deploy cannot run functions, so deploy with Git or the CLI.

1. **Put the code in a Git repo** (GitHub/GitLab) and in Netlify choose *Add new project → Import an existing project*. Build settings come from `netlify.toml` (publish `public`, functions in `netlify/functions`).
   *Or* with the CLI: `npm i -g netlify-cli && netlify login && netlify link && netlify deploy --build --prod`.
2. **Create the database**: in the Netlify project go to *Extensions → Neon / Netlify DB* and create a database (or run `npx netlify db init`). This provides `NETLIFY_DB_URL` automatically. Tables are created on first request.
3. **Set environment variables** (*Project configuration → Environment variables*), see `.env.example`. At minimum: `APP_SECRET`, `SITE_URL`, `ADMIN_EMAILS`.
4. **Redeploy**, then register with an email from `ADMIN_EMAILS`, go to *Account → Two-factor authentication*, enable 2FA, and open *Admin*.
5. **Paystack**: add `PAYSTACK_SECRET_KEY`/`PAYSTACK_PUBLIC_KEY` (test keys first). In the Paystack dashboard set the webhook URL to `https://YOUR-SITE/api/webhooks/paystack`. For automatic payouts, enable Transfers on your Paystack business and set `PAYSTACK_TRANSFERS_ENABLED=true`; otherwise pay out manually and click *Mark paid*.
6. **Odds feed**: get a key at the-odds-api.com, set `ODDS_API_KEY` and `ODDS_API_SPORTS`. The scheduled function imports fixtures/odds and auto-settles Match Result markets from final scores. You can also create events and markets manually in *Admin → Events*.

## Run locally

```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/kickline
export APP_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
export ADMIN_EMAILS=you@example.com INSECURE_COOKIES=1
npm run dev          # http://localhost:8888
npm test             # integration tests (uses DATABASE_URL, which it TRUNCATES — use a test DB)
```

## Operating notes

- Settlement is final. Void a market (stakes returned / accumulators recalculated) if a result is uncertain.
- Manual price edits switch a market off the feed so your price is not overwritten.
- *Admin → Settings* controls stake/payout/deposit/withdrawal limits and can pause betting, deposits or withdrawals instantly.
- Not included yet (needs third-party services): password-reset emails, document-upload KYC, live in-play betting, cash-out.
