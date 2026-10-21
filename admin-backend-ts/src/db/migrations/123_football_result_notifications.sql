-- Ciyaaraha: result notifications for every participant, in each
-- customer's app language, delivered once and retried safely.
-- Additive only, safe to re-run.

-- The language the customer chose in the Customer App ('so' or 'en'),
-- reported by the app. NULL (not reported yet) means Somali.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS app_language TEXT;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_app_language_check;
ALTER TABLE customers ADD CONSTRAINT customers_app_language_check CHECK (app_language IS NULL OR app_language IN ('so','en'));

-- One row per (confirmed winner, participant): queued in the same
-- transaction that confirms the winner, so nothing is sent before the
-- official confirmation and nobody is told twice about the same result.
-- A winner overturned by an Admin (revoked) and a newly confirmed one each
-- get their own rows. The in-app notification is written once
-- (notification_id); only the phone push is retried.
CREATE TABLE IF NOT EXISTS football_notifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id       UUID NOT NULL REFERENCES football_contests(id) ON DELETE RESTRICT,
  winner_id        UUID NOT NULL REFERENCES football_winners(id) ON DELETE RESTRICT,
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  kind             TEXT NOT NULL CHECK (kind IN ('winner','participant')),
  language         TEXT,
  notification_id  UUID,
  push_status      TEXT NOT NULL DEFAULT 'pending' CHECK (push_status IN ('pending','sent','no_device','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ,
  UNIQUE (winner_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_football_notifications_due ON football_notifications(next_attempt_at)
  WHERE notification_id IS NULL OR push_status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS idx_football_notifications_contest ON football_notifications(contest_id);
