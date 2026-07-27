-- Lets a USSD template pin down exactly which physical device + SIM slot
-- should execute it, independent of the per-company sim_routing table (which
-- only supports one ranked device list per company, not per-package). Nullable
-- throughout: an unassigned template keeps falling back to sim_routing, so
-- this is purely additive.
ALTER TABLE ussd_templates ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES agent_devices(id) ON DELETE SET NULL;
ALTER TABLE ussd_templates ADD COLUMN IF NOT EXISTS sim_slot INTEGER CHECK (sim_slot IS NULL OR sim_slot IN (1,2));

-- Carries the resolved override from generateUssdForOrder() onto the order
-- itself, since the Agent App only ever fetches orders, never templates
-- directly — this is how the assignment actually reaches the device that
-- needs to act on it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ussd_device_id UUID REFERENCES agent_devices(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ussd_sim_slot INTEGER CHECK (ussd_sim_slot IS NULL OR ussd_sim_slot IN (1,2));
