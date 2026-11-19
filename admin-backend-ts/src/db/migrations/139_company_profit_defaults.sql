-- Company Commission & Profit: Profit % = Commission % - Discount %.
-- Starting values (changed in the Agent App afterwards): Hormuud 15%,
-- Somnet 15%, Somtel 16%, Amtel 20%, Discount 10%. A network that
-- already has values keeps them. Idempotent: safe to replay on every deploy.
UPDATE company_profit_terms SET profit_pct = commission_pct - COALESCE(discount_pct, 0)
 WHERE commission_pct IS NOT NULL AND profit_pct IS DISTINCT FROM commission_pct - COALESCE(discount_pct, 0);

INSERT INTO company_profit_terms (company_id, commission_pct, discount_pct, profit_pct, updated_by_role)
SELECT c.id, d.commission, 10, d.commission - 10, 'default'
  FROM companies c
  JOIN (VALUES ('hormuud', 15), ('somnet', 15), ('somtel', 16), ('amtel', 20)) AS d(key, commission)
    ON lower(c.name) LIKE d.key || '%'
ON CONFLICT (company_id) DO NOTHING;
