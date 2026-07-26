-- DALAB INTERNET — database schema (SQLite implementation of the Postgres design
-- documented in dalab-backend-architecture.md). Differences from that doc are
-- purely dialect: TEXT instead of UUID/TIMESTAMPTZ, INTEGER 0/1 instead of BOOLEAN,
-- CURRENT_TIMESTAMP instead of now(). Every table, relationship, and constraint is
-- otherwise the same. See README.md for why SQLite is used here instead of Postgres.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  group_number  INTEGER NOT NULL CHECK (group_number IN (1,2)),
  color_hex     TEXT NOT NULL,
  logo_url      TEXT,
  status        TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','offline')),
  gateway       TEXT,
  payment_number TEXT,
  payment_ussd_template TEXT,  -- what the CUSTOMER dials to send payment, e.g. "*712*{number}*{amount}#"
  ussd_code     TEXT,
  pin_encrypted TEXT,           -- this provider's own PIN (AES-256-GCM, see auth/crypto.js) — replaces
                                  -- the earlier single global admin PIN; each provider now has its own
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS packages (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  category_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  old_price     REAL,
  price         REAL NOT NULL CHECK (price >= 0),
  mb            INTEGER NOT NULL DEFAULT 0,
  minutes       INTEGER NOT NULL DEFAULT 0,
  sms           INTEGER NOT NULL DEFAULT 0,
  validity      TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_packages_company_id ON packages(company_id);

CREATE TABLE IF NOT EXISTS customers (
  id            TEXT PRIMARY KEY,
  phone         TEXT NOT NULL UNIQUE,
  name          TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  macaash_points INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id            TEXT PRIMARY KEY,
  phone         TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  consumed      INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_otp_codes_phone ON otp_codes(phone);
CREATE INDEX IF NOT EXISTS idx_otp_codes_expires_at ON otp_codes(expires_at);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  phone         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  device_id     TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'super_admin',
  -- Earlier versions stored a single global ussd_pin_encrypted here. Replaced
  -- by companies.pin_encrypted — each provider now has its own PIN (see
  -- routes/ussd.js) rather than one PIN shared across all four.
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_password_resets (
  id            TEXT PRIMARY KEY,
  admin_id      TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  consumed      INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_password_resets_admin_id ON admin_password_resets(admin_id);

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  package_id      TEXT NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
  amount          REAL NOT NULL CHECK (amount >= 0),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_progress','completed','failed','cancelled')),
  sender_phone    TEXT,
  receiver_phone  TEXT,
  payment_method  TEXT,
  gateway_ref     TEXT,
  channel         TEXT,
  macaash_earned  INTEGER NOT NULL DEFAULT 0,
  agent_id        TEXT REFERENCES agents(id) ON DELETE SET NULL,
  ussd_generated  TEXT,   -- the fully-substituted USSD string, once generated (see ussd_logs for the audit trail)
  completed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_company_id  ON orders(company_id);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_agent_id    ON orders(agent_id);
CREATE INDEX IF NOT EXISTS idx_orders_sender_phone   ON orders(sender_phone);
CREATE INDEX IF NOT EXISTS idx_orders_receiver_phone ON orders(receiver_phone);

CREATE TABLE IF NOT EXISTS macaash_transactions (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  order_id      TEXT REFERENCES orders(id) ON DELETE SET NULL,
  points        INTEGER NOT NULL,
  reason        TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_macaash_tx_customer_id ON macaash_transactions(customer_id);

CREATE TABLE IF NOT EXISTS banners (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  subtitle           TEXT,
  gradient           TEXT,
  target_company_id  TEXT REFERENCES companies(id) ON DELETE SET NULL,
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  position           INTEGER NOT NULL DEFAULT 0,
  start_date         TEXT,
  end_date           TEXT,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_banners_active ON banners(active, position);

CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('push','promotion','maintenance')),
  title         TEXT NOT NULL,
  body          TEXT,
  sent_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sms_logs (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT REFERENCES agents(id) ON DELETE SET NULL,
  sender            TEXT NOT NULL,
  body              TEXT NOT NULL,
  parsed_provider   TEXT,
  parsed_amount     REAL,
  parsed_phone      TEXT,
  matched_order_id  TEXT REFERENCES orders(id) ON DELETE SET NULL,
  received_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sms_logs_agent_id ON sms_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_sms_logs_matched_order ON sms_logs(matched_order_id);

-- A physical Agent Android device — "Mobile 1", "Mobile 2", etc. Each has two
-- physical SIM slots; sim_routing (below) says which provider is assigned to
-- which (device, slot) pair, since "SIM 1" alone is ambiguous once there's
-- more than one device.
CREATE TABLE IF NOT EXISTS agent_devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,  -- "Mobile 1", "Mobile 2"
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Super Admin's SIM 1 / SIM 2 assignment per provider, now scoped to a
-- specific physical device — read by that device's Agent App to pick which
-- SIM subscription to dial USSD on. One row per company; sim_slot is 1 or 2.
CREATE TABLE IF NOT EXISTS sim_routing (
  company_id  TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  device_id   TEXT REFERENCES agent_devices(id) ON DELETE SET NULL,
  sim_slot    INTEGER NOT NULL CHECK (sim_slot IN (1, 2)),
  updated_by  TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sim_routing_device_id ON sim_routing(device_id);

-- USSD dialer templates, one per (provider, service). {number}/{amount}/{pin}
-- placeholders get substituted at generation time — see routes/ussd.js.
CREATE TABLE IF NOT EXISTS ussd_templates (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  service_name  TEXT NOT NULL,
  ussd_code     TEXT NOT NULL,   -- e.g. "*914*{number}*{amount}*8233{pin}#"
  status        TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ussd_templates_company_id ON ussd_templates(company_id);

-- Full audit trail of every generated USSD string — required even though
-- orders.ussd_generated also stores the latest one, because an order could
-- in principle be regenerated (retry) and every attempt should be logged.
CREATE TABLE IF NOT EXISTS ussd_logs (
  id            TEXT PRIMARY KEY,
  order_id      TEXT REFERENCES orders(id) ON DELETE SET NULL,
  template_id   TEXT REFERENCES ussd_templates(id) ON DELETE SET NULL,
  company_id    TEXT REFERENCES companies(id) ON DELETE SET NULL,
  admin_id      TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  generated_string TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ussd_logs_order_id ON ussd_logs(order_id);

-- One row per USSD dial attempt the Agent App makes (including retries) —
-- separate from ussd_logs (which records the generated STRING) because a
-- single generated string can be dialed more than once if the first attempt
-- fails and the app retries.
CREATE TABLE IF NOT EXISTS ussd_dial_attempts (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  agent_id      TEXT REFERENCES agents(id) ON DELETE SET NULL,
  sim_slot      INTEGER,
  ussd_string   TEXT NOT NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  response_message TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ussd_dial_attempts_order_id ON ussd_dial_attempts(order_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            TEXT PRIMARY KEY,
  subject_id    TEXT NOT NULL,   -- customer/agent/admin id
  subject_role  TEXT NOT NULL CHECK (subject_role IN ('customer','agent','super_admin')),
  token_hash    TEXT NOT NULL,
  revoked       INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_subject ON refresh_tokens(subject_id, subject_role);
