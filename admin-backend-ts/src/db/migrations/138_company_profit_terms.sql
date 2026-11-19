-- Company Commission & Profit: the business terms each network gives us,
-- set by the Owner. For each completed order priced P:
--   net commission = P x (commission_pct - discount_pct) / 100
--   profit         = P x profit_pct / 100
-- NULL = not set. Idempotent: safe to replay on every deploy.
CREATE TABLE IF NOT EXISTS company_profit_terms (
  company_id      TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  commission_pct  NUMERIC(5,2) CHECK (commission_pct BETWEEN 0 AND 100),
  discount_pct    NUMERIC(5,2) CHECK (discount_pct BETWEEN 0 AND 100),
  profit_pct      NUMERIC(5,2) CHECK (profit_pct BETWEEN 0 AND 100),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_id   TEXT,
  updated_by_role TEXT
);
