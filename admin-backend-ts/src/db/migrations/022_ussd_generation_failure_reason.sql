-- generateUssdForOrder's failure (no PIN set, or no matching USSD template)
-- was previously discarded entirely at the verify-payment call site — the
-- order still flips to in_progress (correct, a missing PIN/template isn't
-- fatal to the approval itself) but nothing recorded WHY the dial never
-- happened, so a stuck order looked identical whether it failed here or
-- somewhere else entirely. Nullable/additive; cleared back to NULL on a
-- later successful generation so it never shows a stale reason.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ussd_generation_failed_reason TEXT;
