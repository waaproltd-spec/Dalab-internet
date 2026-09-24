-- Offline Orders' "dial this yourself" payment numbers (EVC Plus/Jeeb/
-- eDahab), previously hardcoded in the Customer App
-- (offline_orders_intro_screen.dart's `_ussdPayments` const list). Mirrors
-- shop_payment_methods/reseller_deposit_methods' exact shape (migrations
-- 074/053) so Admin can repoint these independently of Shop and Reseller
-- Deposit, even though all three happen to share the same physical SIMs
-- today. A third method (jeeb) exists here that neither of those two
-- tables has, since Offline Orders is the only one of the three features
-- that accepts Jeeb.
--
-- ussd_template keeps the exact literal "$" placeholder the Customer App
-- already displays (not "{amount}" -- unlike Shop/Reseller Deposit's
-- templates, nothing here is ever substituted client-side; this is a
-- purely informational display for a customer who dials it by hand and
-- types their own amount in place of "$"). Admin edits payment_number and
-- ussd_template as two separate fields, same as the other two tables --
-- keeping the embedded number in ussd_template consistent with
-- payment_number is on the admin, exactly like Shop/Reseller Deposit's own
-- edit forms already work.
CREATE TABLE IF NOT EXISTS offline_payment_methods (
  method          TEXT PRIMARY KEY CHECK (method IN ('evc', 'jeeb', 'edahab')),
  label           TEXT NOT NULL,
  payment_number  TEXT NOT NULL,
  ussd_template   TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT
);
INSERT INTO offline_payment_methods (method, label, payment_number, ussd_template) VALUES
  ('evc', 'EVC Plus', '610338686', '*712*610338686*$#'),
  ('jeeb', 'Jeeb', '610338686', '*812*610338686*$#'),
  ('edahab', 'eDahab', '620338686', '*712*620338686*$#')
ON CONFLICT (method) DO NOTHING;
