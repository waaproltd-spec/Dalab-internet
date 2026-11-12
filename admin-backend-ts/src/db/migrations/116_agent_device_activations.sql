-- Device Activation: an Agent App install must be approved by an admin
-- before it can use any agent API. One row per (agent, app install).
--   install_id     random id the app generates once per installation
--                  (a reinstall / new phone = a new install = new approval)
--   device_number  the 7-digit "ID 1360532" shown on the activation screen
--   code_hash      HMAC of the current 4-character activation code (lookup)
--   code_encrypted the same code, AES-GCM encrypted, so the app can show it
--                  again; never stored in plain text
CREATE TABLE IF NOT EXISTS agent_device_activations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  install_id       TEXT NOT NULL,
  device_number    TEXT NOT NULL UNIQUE,
  device_model     TEXT,
  agent_device_id  TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','revoked')),
  code_hash        TEXT,
  code_encrypted   TEXT,
  code_expires_at  TIMESTAMPTZ,
  code_used_at     TIMESTAMPTZ,
  approved_by      UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  approved_at      TIMESTAMPTZ,
  approval_note    TEXT,
  rejected_by      UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  rejected_at      TIMESTAMPTZ,
  revoked_by       UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  revoked_at       TIMESTAMPTZ,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, install_id)
);

-- A live (pending) code must point at exactly one device.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_device_activations_pending_code
  ON agent_device_activations (code_hash) WHERE status = 'pending' AND code_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_device_activations_agent ON agent_device_activations (agent_id);

-- When Device Activation was switched on. An agent who was already using
-- the app before this moment gets their first device approved
-- automatically (recorded as such), so existing phones aren't locked out.
CREATE TABLE IF NOT EXISTS device_activation_rollout (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO device_activation_rollout (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
