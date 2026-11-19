-- The one SIM the Super Admin chose for a balance (EVC Plus, eDahab,
-- Hormuud, Somtel, Somnet, Amtel -- keyed by provider_key): when a balance
-- has a chosen SIM, only that phone + SIM slot's balance messages, USSD
-- replies and manual entries are read, and the Balance Dashboard, its
-- totals, the finance overview and the AGENT APP show only that SIM for
-- it. A balance with no chosen SIM works exactly as before. Removing the
-- phone removes the choice.
CREATE TABLE IF NOT EXISTS balance_selected_sims (
  provider_key   TEXT PRIMARY KEY,
  device_id      TEXT NOT NULL REFERENCES agent_devices(id) ON DELETE CASCADE,
  sim_slot       INTEGER NOT NULL CHECK (sim_slot IN (1, 2)),
  selected_by    UUID,
  selected_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
