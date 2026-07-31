-- Payment wallets shown in the Customer App's "Select Payment Method" sheet.
-- Each wallet is a dial-prefix + logo/display config only — the actual
-- payment number stays per-company (companies.payment_number), unchanged.
-- Combined client-side as "*{dial_prefix}*{company.payment_number}*{amount}#".
CREATE TABLE IF NOT EXISTS payment_wallets (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  provider_label TEXT,
  dial_prefix    TEXT NOT NULL,
  logo_key       TEXT NOT NULL,
  color_hex      TEXT NOT NULL DEFAULT '#16A34A',
  enabled        BOOLEAN NOT NULL DEFAULT true,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO payment_wallets (id, name, provider_label, dial_prefix, logo_key, color_hex, sort_order) VALUES
  ('evc_plus',  'EVC Plus',  'Hormuud', '712', 'hormuud', '#16A34A', 1),
  ('edahab',    'eDahab',    'Somtel',  '110', 'somtel',  '#F2C200', 2),
  ('jeeb',      'JEEB',      'Somnet',  '812', 'somnet',  '#1D4ED8', 3),
  ('amtel_pay', 'Amtel Pay', 'Amtel',   '888', 'amtel',   '#DC2626', 4)
ON CONFLICT (id) DO NOTHING;
