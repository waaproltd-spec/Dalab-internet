-- Agent device automation health (sent with every heartbeat by Agent App
-- builds that have DeviceHealthSnapshot). Lets the Admin Dashboard tell "the
-- phone is online" apart from "the phone can actually do its job".
-- Additive only; NULL = not reported (older app) / unknown. Safe to re-run.
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS sms_permission BOOLEAN;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS pending_sms_count INTEGER;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS oldest_pending_sms_age_sec BIGINT;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS pending_action_count INTEGER;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS last_sms_upload_at TIMESTAMPTZ;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS accessibility_reseller_enabled BOOLEAN;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS accessibility_exchange_enabled BOOLEAN;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS battery_optimization_ignored BOOLEAN;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS phone_permission BOOLEAN;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS service_started_at TIMESTAMPTZ;
ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS app_version TEXT;
