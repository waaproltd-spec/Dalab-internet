-- Which physical agent device/SIM collects payments for this specific
-- method (e.g. a company's EVC Plus vs eDahab vs JEEB number are usually
-- different telcos, each needing its own SIM). sim_slot narrows this to a
-- specific SIM on a dual-SIM payment device — a payment device commonly
-- has two SIMs, each with its own payment number, so the device alone
-- can't tell them apart. Both nullable — a method with no device (and no
-- slot) assigned yet just isn't checkable for payment-verification
-- purposes (see smsLogs.routes.ts's findMatchingOrder), same as before
-- these columns existed. Deliberately a separate device from the one
-- ussd_templates.device_id/sim_slot points at (007_ussd_template_device_
-- assignment.sql) — that's the EXECUTION device dialing USSD to deliver
-- packages, a different physical phone from the one collecting payments.
ALTER TABLE company_payment_methods ADD COLUMN IF NOT EXISTS device_id TEXT REFERENCES agent_devices(id) ON DELETE SET NULL;
ALTER TABLE company_payment_methods ADD COLUMN IF NOT EXISTS sim_slot INTEGER CHECK (sim_slot IS NULL OR sim_slot IN (1,2));

-- Which SIM slot on the uploading device actually received this SMS,
-- reported by the Agent App (see SmsReceiver.resolveSimSlot) — matched
-- against company_payment_methods.sim_slot above during payment
-- verification. Null for SMS uploaded before this existed, or from a
-- single-SIM device/older app build that can't resolve it.
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS sim_slot INTEGER CHECK (sim_slot IS NULL OR sim_slot IN (1,2));
