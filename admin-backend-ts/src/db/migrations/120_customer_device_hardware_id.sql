-- Trusted Devices showed the same phone several times: every reinstall or
-- app-data clear makes a new per-install device_id. hardware_id is a SHA-256
-- of the phone's own Android ID (the same across reinstalls of the same app),
-- sent by newer Customer App builds; a login from a new install on a phone
-- already listed updates that row instead of adding another. Additive only;
-- older app builds leave it null and behave as before.
ALTER TABLE customer_devices ADD COLUMN IF NOT EXISTS hardware_id TEXT;
CREATE INDEX IF NOT EXISTS idx_customer_devices_hardware
  ON customer_devices(customer_id, hardware_id) WHERE hardware_id IS NOT NULL;
