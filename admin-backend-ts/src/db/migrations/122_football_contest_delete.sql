-- Ciyaaraha: let an agent delete a contest nobody has predicted yet (e.g.
-- created with a typo). A deleted contest is kept, marked cancelled and
-- hidden from every list, so its audit trail stays. Contests with
-- predictions can't be deleted -- they're cancelled instead.
-- Additive only, safe to re-run.
ALTER TABLE football_contests ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE football_contests ADD COLUMN IF NOT EXISTS deleted_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
