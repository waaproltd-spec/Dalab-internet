-- Central Balance Management Dashboard: tracks the real, carrier-reported
-- available balance of every physical payment SIM (one row per device+slot,
-- since that's the addressable physical identity — company/provider is
-- resolved via sim_routing and can be overridden manually per row), plus a
-- full audit history of every change (SMS-detected or manual).
CREATE TABLE IF NOT EXISTS sim_balances (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id              TEXT NOT NULL REFERENCES agent_devices(id) ON DELETE CASCADE,
  sim_slot               INTEGER NOT NULL CHECK (sim_slot IN (1,2)),
  company_id             TEXT REFERENCES companies(id) ON DELETE SET NULL,
  phone_number           TEXT,
  balance                NUMERIC(12,2) NOT NULL DEFAULT 0,
  low_balance_threshold  NUMERIC(12,2) NOT NULL DEFAULT 5,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_id, sim_slot)
);

CREATE TABLE IF NOT EXISTS sim_balance_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sim_balance_id    UUID NOT NULL REFERENCES sim_balances(id) ON DELETE CASCADE,
  previous_balance  NUMERIC(12,2),
  new_balance       NUMERIC(12,2) NOT NULL,
  change_amount     NUMERIC(12,2),
  order_id          TEXT REFERENCES orders(id) ON DELETE SET NULL,
  sms_log_id        UUID REFERENCES sms_logs(id) ON DELETE SET NULL,
  source            TEXT NOT NULL DEFAULT 'sms' CHECK (source IN ('sms','manual')),
  changed_by        UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sim_balance_history_sim ON sim_balance_history(sim_balance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sim_balance_history_created ON sim_balance_history(created_at DESC);
