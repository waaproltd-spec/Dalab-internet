-- Admin Hub (admin.waaproltd.com): admins sign in once at the hub and open
-- this system from there. hub_user_id links a local admin to the hub
-- account; disabled_at is set when the hub removes their access here (or
-- disables the account), which ends their sessions in this system at once.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS hub_user_id UUID UNIQUE;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- Every signed message from the hub is single-use (its jti is recorded
-- until it would have expired anyway).
CREATE TABLE IF NOT EXISTS hub_used_tokens (
  jti        TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

-- System Control (Admin Hub): whether the Platform Owner has suspended this
-- whole system. One row; kept here so it survives restarts and still holds
-- if the hub can't be reached. Suspending never changes any other data.
CREATE TABLE IF NOT EXISTS hub_system_state (
  id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  suspended  BOOLEAN NOT NULL DEFAULT false,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by TEXT
);
