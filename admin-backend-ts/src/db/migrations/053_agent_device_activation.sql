-- Per-device secret an agent must provide once to activate a physical phone
-- (see auth.routes.ts's /agent/auth/device-login) -- bcrypt-hashed, never
-- stored in plaintext. NULL means "no code configured for this device",
-- which keeps every already-deployed device working exactly as before
-- (nothing before this migration ever set or required one) until an admin
-- explicitly generates one for it.
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS activation_code_hash TEXT;
