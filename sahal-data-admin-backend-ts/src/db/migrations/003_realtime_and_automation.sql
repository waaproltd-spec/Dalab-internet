-- SAHAL DATA — real-time sync + automated payment pipeline additions
-- Adds: per-company auto-processing toggle, device enable/disable, and a
-- real FK tying an agent to their assigned device. Applied after
-- 002_admin_controls.sql via `npm run migrate` (see src/db/migrate.ts) —
-- every statement is safe to re-run.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_process_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE agent_devices ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;

-- agents.device_id has existed as a plain TEXT column since 001_init.sql
-- with no referential integrity, so any stray/never-cleaned value could
-- violate the FK below — clear anything that doesn't match a real device
-- before enforcing it (device_id was never surfaced in any UI, so this is
-- expected to be a no-op in practice).
UPDATE agents SET device_id = NULL
WHERE device_id IS NOT NULL AND device_id NOT IN (SELECT id FROM agent_devices);

-- Guarded because Postgres has no `ADD CONSTRAINT IF NOT EXISTS`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_device_id_fkey'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_device_id_fkey
      FOREIGN KEY (device_id) REFERENCES agent_devices(id) ON DELETE SET NULL;
  END IF;
END $$;
