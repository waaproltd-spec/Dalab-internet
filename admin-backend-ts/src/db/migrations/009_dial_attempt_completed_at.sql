-- Lets the Execution Logs view show an actual end time and processing
-- duration per dial attempt, not just the start (created_at). Set once,
-- the same moment status flips from 'pending' to 'success'/'failed'.
ALTER TABLE ussd_dial_attempts ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
