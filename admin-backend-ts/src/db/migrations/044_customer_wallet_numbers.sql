-- Lets a customer save their own EVC Plus / eDahab numbers once on their
-- Account, so Money Exchange can auto-fill the sender/receiver numbers for
-- a corridor instead of asking them to type both every time (see
-- customers.routes.ts PUT /customer/wallet-numbers and the Customer App's
-- exchange_new_screen.dart). Stored in the same "252XXXXXXXXX" E.164 shape
-- every other phone column in this schema already uses.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS evc_plus_number TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS edahab_number TEXT;
