-- DALAB INTERNET — dual-device reliability additions
-- Adds: device health telemetry (battery/network/SIM presence reported by
-- each Agent App instance), priority-ranked multi-device SIM routing (a
-- company can now have a primary + backup device instead of exactly one),
-- and SMS dedup protection. Applied after 003_realtime_and_automation.sql
-- via `npm run migrate` — every statement is safe to re-run.

ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS battery_percent INTEGER;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS network_online BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS sim1_present BOOLEAN;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS sim2_present BOOLEAN;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

-- sim_routing previously allowed exactly one device per company
-- (company_id was the sole primary key) — widen it to a ranked list so a
-- business that has actually provisioned a second SIM for the same
-- provider can register a backup device. priority=1 is primary; existing
-- rows keep their current pairing unchanged at priority=1.
ALTER TABLE sim_routing DROP CONSTRAINT IF EXISTS sim_routing_pkey;
ALTER TABLE sim_routing ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 1;

-- A composite (company_id, device_id) primary key requires both columns
-- NOT NULL — a row with no device assigned yet was never actionable for
-- dialing anyway (nothing to route to), so it's dropped rather than kept
-- with a placeholder device_id. The admin dashboard re-creates the row the
-- moment a device is actually assigned.
DELETE FROM sim_routing WHERE device_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sim_routing_company_device_pkey'
  ) THEN
    ALTER TABLE sim_routing
      ADD CONSTRAINT sim_routing_company_device_pkey PRIMARY KEY (company_id, device_id);
  END IF;
END $$;

-- Guards against a redelivered SMS broadcast (rare on Android, but possible)
-- creating two separate sms_logs rows — and therefore two separate order
-- matches/dial attempts — for what is physically the same message.
-- date_trunc(text, timestamptz) is STABLE (timezone-dependent), which
-- Postgres rejects in an index expression — normalize to UTC first via
-- `AT TIME ZONE`, which drops the type down to a plain timestamp and makes
-- date_trunc IMMUTABLE.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_logs_dedup
  ON sms_logs (sender, body, date_trunc('minute', received_at AT TIME ZONE 'UTC'));
