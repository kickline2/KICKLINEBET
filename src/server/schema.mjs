// Ordered, append-only migrations. Never edit an applied migration; add a new one.
export const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE users (
  id               BIGSERIAL PRIMARY KEY,
  email            TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  phone            TEXT,
  date_of_birth    DATE NOT NULL,
  role             TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  kyc_status       TEXT NOT NULL DEFAULT 'unverified' CHECK (kyc_status IN ('unverified','pending','verified','rejected')),
  failed_logins    INT NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ,
  totp_secret      TEXT,
  totp_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  totp_last_step   BIGINT,
  self_excluded_until TIMESTAMPTZ,
  terms_accepted_at TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE wallets (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance    BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  currency   TEXT NOT NULL DEFAULT 'GHS',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  amount        BIGINT NOT NULL CHECK (amount <> 0),
  balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
  kind          TEXT NOT NULL CHECK (kind IN ('deposit','withdrawal','withdrawal_reversal','bet_stake','bet_payout','bet_refund','adjustment')),
  ref_type      TEXT NOT NULL,
  ref_id        TEXT NOT NULL,
  description   TEXT,
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Guarantees each business event moves money at most once.
CREATE UNIQUE INDEX ledger_idem_uq ON ledger_entries (kind, ref_type, ref_id);
CREATE INDEX ledger_user_idx ON ledger_entries (user_id, id DESC);

CREATE TABLE deposits (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  reference     TEXT NOT NULL UNIQUE,
  amount        BIGINT NOT NULL CHECK (amount > 0),
  currency      TEXT NOT NULL DEFAULT 'GHS',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed','abandoned')),
  channel       TEXT,
  provider_data JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX deposits_user_idx ON deposits (user_id, created_at DESC);

CREATE TABLE withdrawals (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  reference      TEXT NOT NULL UNIQUE,
  amount         BIGINT NOT NULL CHECK (amount > 0),
  method         TEXT NOT NULL CHECK (method IN ('mobile_money','ghipss')),
  bank_code      TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','paid','rejected','failed')),
  recipient_code TEXT,
  transfer_code  TEXT,
  note           TEXT,
  reviewed_by    BIGINT REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX withdrawals_status_idx ON withdrawals (status, created_at);
CREATE INDEX withdrawals_user_idx ON withdrawals (user_id, created_at DESC);

CREATE TABLE events (
  id           BIGSERIAL PRIMARY KEY,
  sport_key    TEXT NOT NULL,
  sport_title  TEXT NOT NULL,
  league       TEXT,
  home_team    TEXT NOT NULL,
  away_team    TEXT NOT NULL,
  start_time   TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','finished','cancelled')),
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','oddsapi')),
  external_id  TEXT UNIQUE,
  home_score   INT,
  away_score   INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_start_idx ON events (status, start_time);

CREATE TABLE markets (
  id          BIGSERIAL PRIMARY KEY,
  event_id    BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'custom',
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','suspended','settled','void')),
  auto_odds   BOOLEAN NOT NULL DEFAULT FALSE,
  settled_at  TIMESTAMPTZ,
  settled_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, name)
);

CREATE TABLE selections (
  id          BIGSERIAL PRIMARY KEY,
  market_id   BIGINT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  odds_milli  INT NOT NULL CHECK (odds_milli > 1000),
  result      TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','won','lost','void')),
  sort_order  INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_id, name)
);

CREATE TABLE bets (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id),
  stake            BIGINT NOT NULL CHECK (stake > 0),
  total_odds       NUMERIC(20,6) NOT NULL,
  potential_payout BIGINT NOT NULL,
  payout           BIGINT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','void')),
  idempotency_key  TEXT NOT NULL,
  ip               TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at       TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX bets_user_idx ON bets (user_id, id DESC);
CREATE INDEX bets_status_idx ON bets (status);

CREATE TABLE bet_legs (
  id            BIGSERIAL PRIMARY KEY,
  bet_id        BIGINT NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  selection_id  BIGINT NOT NULL REFERENCES selections(id),
  market_id     BIGINT NOT NULL REFERENCES markets(id),
  event_id      BIGINT NOT NULL REFERENCES events(id),
  odds_milli    INT NOT NULL,
  result        TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','won','lost','void')),
  UNIQUE (bet_id, event_id)
);
CREATE INDEX bet_legs_market_idx ON bet_legs (market_id);

CREATE TABLE deposit_limits (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period               TEXT NOT NULL CHECK (period IN ('daily','weekly','monthly')),
  amount               BIGINT CHECK (amount IS NULL OR amount > 0),
  pending_amount       BIGINT,
  pending_clear        BOOLEAN NOT NULL DEFAULT FALSE,
  pending_effective_at TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period)
);

CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count        INT NOT NULL
);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    BIGINT REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  details     JSONB,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_log (created_at DESC);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id           BIGSERIAL PRIMARY KEY,
  provider     TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL,
  event_type   TEXT,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  error        TEXT,
  UNIQUE (provider, dedupe_key)
);
`,
  },
];
