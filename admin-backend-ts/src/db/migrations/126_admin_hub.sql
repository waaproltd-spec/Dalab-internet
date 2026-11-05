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
