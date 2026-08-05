-- Replaces OTP as the Customer App's day-to-day login method with a real
-- password (bcrypt-hashed, same as admin_users.password_hash and
-- customers.pin_hash — see auth/crypto.ts's hashPassword). email is
-- optional (a customer may only ever have a phone number, same as today)
-- and, when present, is a second way to look the account up at login —
-- phone stays the required, unique primary identifier.
--
-- Existing customers created via the old OTP flow have password_hash=NULL;
-- POST /auth/register on an already-existing phone number sets the
-- password on that same row rather than erroring or creating a duplicate,
-- so every historical customer/order/points balance carries over untouched
-- the first time that person signs in under the new system.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers(email) WHERE email IS NOT NULL;
