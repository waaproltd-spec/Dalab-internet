-- Super-Admin-configurable registry of which real SMS sender ID(s) each
-- money-provider network is allowed to send from -- e.g. Hormuud EVC Plus
-- and Somnet-branded EVC Plus both send from short code "192"; Somtel
-- eDahab sends from "eDahab". Sender identity is a property of the
-- telecom network itself, not of any individual payment_wallets /
-- company_payment_methods / exchange_payout_wallets row, so this is
-- deliberately a small global table keyed by provider_key rather than a
-- column on any of those -- every number/wallet a Super Admin creates for
-- a given provider is checked against the same provider_key's senders.
--
-- Consumed by the Agent App's PaymentSmsParsers.kt (incoming customer
-- payment SMS) and ExchangePayoutSentParsers.kt (outgoing payout
-- confirmation SMS) via GET /agent/sms-sender-ids, replacing what were
-- previously hardcoded Kotlin sender lists.
CREATE TABLE IF NOT EXISTS sms_sender_ids (
  id           TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL,
  sender       TEXT NOT NULL,
  label        TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_key, sender)
);

CREATE INDEX IF NOT EXISTS idx_sms_sender_ids_provider ON sms_sender_ids(provider_key);

-- Seeded with today's known-good values (confirmed live this session via
-- real SMS diagnostics/screenshots) so behavior is identical to the
-- hardcoded lists from the moment this ships -- including SomnetEvcPlusParser,
-- which never had a confirmed sender to validate against until now.
INSERT INTO sms_sender_ids (id, provider_key, sender, label) VALUES
  (gen_random_uuid()::text, 'hormuud_evc_plus', '192', 'Hormuud EVC Plus'),
  (gen_random_uuid()::text, 'hormuud_evc_plus', 'EVCPLUS', 'Hormuud EVC Plus'),
  (gen_random_uuid()::text, 'somtel_edahab', 'eDahab', 'Somtel eDahab'),
  (gen_random_uuid()::text, 'somnet_evc_plus', '192', 'Somnet EVC Plus')
ON CONFLICT (provider_key, sender) DO NOTHING;
