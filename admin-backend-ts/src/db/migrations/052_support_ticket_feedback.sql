-- Post-resolution "did this help?" signal (👍/👎), set at most once per
-- ticket by the customer themselves -- lets the team measure how effective
-- the AI + Agent support flow actually is, from real customer input rather
-- than a guess.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS customer_feedback BOOLEAN;
