-- generateUssdForOrder() inlines the provider's plaintext PIN into the dial
-- string (the Agent App must dial the real thing). These masked twins let
-- every non-agent-facing response show the same string with the PIN
-- redacted, without duplicating the secret anywhere new or touching the
-- raw column the Agent App actually dials from.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ussd_generated_masked TEXT;
ALTER TABLE ussd_dial_attempts ADD COLUMN IF NOT EXISTS ussd_string_masked TEXT;
ALTER TABLE ussd_logs ADD COLUMN IF NOT EXISTS generated_string_masked TEXT;
