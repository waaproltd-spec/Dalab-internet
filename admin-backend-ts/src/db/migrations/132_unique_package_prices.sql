-- Every active service of a company gets its own price. Where two or more
-- cost the same, the oldest keeps its price and each later one gets the
-- next free price one cent up ($5.00, $5.01, $5.02, ...). The amount sent
-- to the carrier stays the original price: a moved service without its own
-- provider amount gets provider_amount = its original price (the USSD dial
-- uses provider_amount, falling back to price), so only what the customer
-- pays changes. Each change is written to the Activity Log.
DO $$
DECLARE
  r RECORD;
  taken INT[];
  kept INT[];
  cur_company TEXT := NULL;
  c INT;
BEGIN
  FOR r IN
    SELECT id, company_id, price, provider_amount FROM packages
     WHERE active = true
     ORDER BY company_id, created_at, sort_order, id
  LOOP
    IF cur_company IS DISTINCT FROM r.company_id THEN
      cur_company := r.company_id;
      kept := ARRAY[]::INT[];
      SELECT COALESCE(array_agg(DISTINCT ROUND(price * 100)::INT), ARRAY[]::INT[]) INTO taken
        FROM packages WHERE company_id = r.company_id AND active = true;
    END IF;
    c := ROUND(r.price * 100)::INT;
    IF c = ANY(kept) THEN
      WHILE c = ANY(taken) LOOP c := c + 1; END LOOP;
      UPDATE packages SET price = c / 100.0, provider_amount = COALESCE(provider_amount, r.price) WHERE id = r.id;
      INSERT INTO admin_activity_log (action, entity_type, entity_id, old_value, new_value)
      VALUES ('package_price_made_unique', 'package', r.id::text,
              jsonb_build_object('price', r.price, 'providerAmount', r.provider_amount),
              jsonb_build_object('price', c / 100.0, 'providerAmount', COALESCE(r.provider_amount, r.price)));
      taken := taken || c;
    END IF;
    kept := kept || c;
  END LOOP;
END $$;
