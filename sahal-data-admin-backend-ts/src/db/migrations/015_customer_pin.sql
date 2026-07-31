-- Optional customer-facing PIN, managed exclusively by the Super Admin (not
-- self-service — "if a customer forgets their PIN, they contact Support").
-- Stored as a bcrypt hash, same as admin passwords — never plaintext, never
-- returned to any client. Nullable/optional: a customer with no PIN set
-- behaves exactly as before this migration; the existing OTP login flow is
-- completely untouched.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS pin_hash TEXT;
