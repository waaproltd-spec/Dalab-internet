-- Ciyaaraha: football exact-score prediction contests.
--
-- Customers predict the exact final score of a match before kickoff. After
-- an authorized agent enters the official score, the server picks the
-- EARLIEST exact-score prediction (server clock, ties broken by insert
-- order) as the candidate; the agent confirms it, the customer is notified,
-- and the agent records the (manually delivered) internet reward.
--
-- Additive only: new tables + one agent flag + one notification type.
-- Safe to re-run (every statement is IF NOT EXISTS / DROP ... IF EXISTS).
-- Rollback: DROP the football_* / media_images / cleanup_runs tables and
-- the agents.ciyaaraha_enabled column; nothing existing depends on them.

-- Only agents the Admin switches on may run contests.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS ciyaaraha_enabled BOOLEAN NOT NULL DEFAULT false;

-- Uploaded images (match pictures, team logos) live on disk (MEDIA_DIR);
-- this table holds only metadata so the cleanup job knows what each file
-- is for and when it may be removed.
CREATE TABLE IF NOT EXISTS media_images (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key           TEXT NOT NULL UNIQUE,
  mime_type             TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
  size_bytes            INTEGER NOT NULL CHECK (size_bytes > 0),
  purpose               TEXT NOT NULL CHECK (purpose IN ('contest_image','team_logo')),
  uploaded_by_agent_id  UUID REFERENCES agents(id) ON DELETE SET NULL,
  uploaded_by_admin_id  UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending_deletion','deleted')),
  delete_requested_at   TIMESTAMPTZ,
  deleted_at            TIMESTAMPTZ,
  delete_error          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_images_status ON media_images(status, created_at);

CREATE TABLE IF NOT EXISTS football_teams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  logo_image_id UUID REFERENCES media_images(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_football_teams_name ON football_teams (lower(name));

CREATE TABLE IF NOT EXISTS football_contests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  home_team_id          UUID NOT NULL REFERENCES football_teams(id),
  away_team_id          UUID NOT NULL REFERENCES football_teams(id),
  league                TEXT NOT NULL,
  kickoff_at            TIMESTAMPTZ NOT NULL,
  predictions_close_at  TIMESTAMPTZ NOT NULL,
  reward_label          TEXT NOT NULL,                       -- e.g. "1 GB Internet"
  reward_company_id     TEXT NOT NULL REFERENCES companies(id),
  image_id              UUID REFERENCES media_images(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                          'draft','open','closed','awaiting_result','verification',
                          'completed','no_winner','cancelled','disputed')),
  official_home_goals   SMALLINT CHECK (official_home_goals BETWEEN 0 AND 30),
  official_away_goals   SMALLINT CHECK (official_away_goals BETWEEN 0 AND 30),
  result_entered_at     TIMESTAMPTZ,
  result_entered_by     UUID REFERENCES agents(id) ON DELETE SET NULL,
  candidate_prediction_id UUID,
  status_reason         TEXT,
  created_by_agent_id   UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_by_admin_id   UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  published_at          TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (home_team_id <> away_team_id),
  CHECK (predictions_close_at <= kickoff_at),
  CHECK ((official_home_goals IS NULL) = (official_away_goals IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_football_contests_status ON football_contests(status, kickoff_at);
CREATE INDEX IF NOT EXISTS idx_football_contests_kickoff ON football_contests(kickoff_at DESC);

-- One official prediction per customer per contest. created_at is the
-- server's clock at insert (clock_timestamp, not the transaction start);
-- seq breaks exact-microsecond ties by insert order. Neither the score nor
-- the time can be changed afterwards (trigger below).
CREATE TABLE IF NOT EXISTS football_predictions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          BIGSERIAL UNIQUE,
  contest_id   UUID NOT NULL REFERENCES football_contests(id) ON DELETE RESTRICT,
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  home_goals   SMALLINT NOT NULL CHECK (home_goals BETWEEN 0 AND 30),
  away_goals   SMALLINT NOT NULL CHECK (away_goals BETWEEN 0 AND 30),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (contest_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_football_predictions_score ON football_predictions(contest_id, home_goals, away_goals, created_at, seq);
CREATE INDEX IF NOT EXISTS idx_football_predictions_customer ON football_predictions(customer_id, created_at DESC);

CREATE OR REPLACE FUNCTION football_predictions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.contest_id <> OLD.contest_id OR NEW.customer_id <> OLD.customer_id
     OR NEW.home_goals <> OLD.home_goals OR NEW.away_goals <> OLD.away_goals
     OR NEW.created_at <> OLD.created_at OR NEW.seq <> OLD.seq THEN
    RAISE EXCEPTION 'football predictions cannot be changed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_football_predictions_immutable ON football_predictions;
CREATE TRIGGER trg_football_predictions_immutable BEFORE UPDATE ON football_predictions
  FOR EACH ROW EXECUTE FUNCTION football_predictions_immutable();

-- One current winner per contest (single-winner contests). A winner an
-- Admin overturns after a dispute is kept as 'revoked' (never deleted), so
-- the uniqueness only applies to non-revoked rows.
CREATE TABLE IF NOT EXISTS football_winners (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id      UUID NOT NULL REFERENCES football_contests(id) ON DELETE RESTRICT,
  prediction_id   UUID NOT NULL UNIQUE REFERENCES football_predictions(id) ON DELETE RESTRICT,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  status          TEXT NOT NULL DEFAULT 'winner_confirmed' CHECK (status IN (
                    'winner_confirmed','reward_pending','reward_paid','reward_failed','disputed','revoked')),
  confirmed_by    UUID REFERENCES agents(id) ON DELETE SET NULL,
  confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_football_winners_status ON football_winners(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_football_winners_one_current ON football_winners(contest_id) WHERE status <> 'revoked';

-- Every reward delivery attempt. At most one 'paid' row per contest, so a
-- reward can never be recorded as delivered twice.
CREATE TABLE IF NOT EXISTS football_reward_transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id       UUID NOT NULL REFERENCES football_contests(id) ON DELETE RESTRICT,
  winner_id        UUID NOT NULL REFERENCES football_winners(id) ON DELETE RESTRICT,
  attempt_no       INTEGER NOT NULL,
  reward_label     TEXT NOT NULL,
  company_id       TEXT NOT NULL REFERENCES companies(id),
  recipient_phone  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('paid','failed')),
  transaction_ref  TEXT,
  note             TEXT,
  recorded_by      UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (winner_id, attempt_no),
  CHECK (status <> 'paid' OR coalesce(trim(transaction_ref), '') <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_football_reward_one_paid ON football_reward_transactions(contest_id) WHERE status = 'paid';

-- Audit trail: every result entry/correction, winner confirmation, reward,
-- dispute, cancellation and automatic status change.
CREATE TABLE IF NOT EXISTS football_contest_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id  UUID NOT NULL REFERENCES football_contests(id) ON DELETE RESTRICT,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('agent','admin','system')),
  actor_id    UUID,
  action      TEXT NOT NULL,
  old_value   JSONB,
  new_value   JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_football_contest_events_contest ON football_contest_events(contest_id, created_at);

-- One row per run of a cleanup job, for monitoring.
CREATE TABLE IF NOT EXISTS cleanup_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job          TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  processed    INTEGER NOT NULL DEFAULT 0,
  deleted      INTEGER NOT NULL DEFAULT 0,
  errors       INTEGER NOT NULL DEFAULT 0,
  detail       JSONB
);
CREATE INDEX IF NOT EXISTS idx_cleanup_runs_job ON cleanup_runs(job, started_at DESC);

-- Winner notifications.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (
  type = ANY (ARRAY[
    'push','promotion','maintenance','feedback_update','exchange_update','order_update','campaign',
    'shop_order_update','shop_return_update','shop_back_in_stock','vip_number_order_update','vip_number_package_order_update',
    'friend_request','friend_accepted','friend_message','new_device_login','football_contest'
  ])
) NOT VALID;
