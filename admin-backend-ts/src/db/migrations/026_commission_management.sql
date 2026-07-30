-- Commission Management: tracks the money earned by the company/Super Admin
-- from every completed order — configurable per provider (company), per
-- package, or globally, and calculated automatically whenever an order
-- completes (mirrors how Macaash reward points are already credited
-- automatically today).

-- A commission rule: a percentage or fixed amount, scoped to exactly one of
-- global / a specific company / a specific package. The CHECK below enforces
-- that scope_type and the two nullable FK columns always agree, so a rule can
-- never be ambiguous about what it applies to.
CREATE TABLE IF NOT EXISTS commission_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  scope_type    TEXT NOT NULL CHECK (scope_type IN ('global', 'company', 'package')),
  company_id    TEXT REFERENCES companies(id) ON DELETE CASCADE,
  package_id    UUID REFERENCES packages(id) ON DELETE CASCADE,
  rule_type     TEXT NOT NULL CHECK (rule_type IN ('percentage', 'fixed')),
  value         NUMERIC(10,2) NOT NULL CHECK (value >= 0),
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (scope_type = 'global'  AND company_id IS NULL     AND package_id IS NULL) OR
    (scope_type = 'company' AND company_id IS NOT NULL AND package_id IS NULL) OR
    (scope_type = 'package' AND company_id IS NOT NULL AND package_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_commission_rules_company ON commission_rules(company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commission_rules_package ON commission_rules(package_id) WHERE package_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commission_rules_enabled ON commission_rules(enabled) WHERE enabled;

-- One row per completed order, written automatically the instant that order
-- completes (never user-entered). 'reversed' rows offset an 'earned' row the
-- same way macaash_transactions' kind='reversal' does when an order is later
-- reversed — the original row is never mutated/deleted, so history stays
-- intact. The two partial unique indexes make crediting/reversing idempotent
-- under retries or concurrent completion signals, exactly like
-- idx_macaash_tx_order_earn/idx_macaash_tx_order_reversal already do.
CREATE TABLE IF NOT EXISTS commission_records (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            TEXT REFERENCES orders(id) ON DELETE SET NULL,
  rule_id             UUID REFERENCES commission_rules(id) ON DELETE SET NULL,
  company_id          TEXT REFERENCES companies(id) ON DELETE SET NULL,
  package_id          UUID REFERENCES packages(id) ON DELETE SET NULL,
  order_amount        NUMERIC(10,2) NOT NULL,
  rule_type           TEXT NOT NULL CHECK (rule_type IN ('percentage', 'fixed')),
  rule_value          NUMERIC(10,2) NOT NULL,
  commission_amount   NUMERIC(10,2) NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'earned' CHECK (kind IN ('earned', 'reversed')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commission_records_company ON commission_records(company_id);
CREATE INDEX IF NOT EXISTS idx_commission_records_package ON commission_records(package_id);
CREATE INDEX IF NOT EXISTS idx_commission_records_created_at ON commission_records(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commission_records_order_earned
  ON commission_records(order_id) WHERE kind = 'earned' AND order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_commission_records_order_reversed
  ON commission_records(order_id) WHERE kind = 'reversed' AND order_id IS NOT NULL;
