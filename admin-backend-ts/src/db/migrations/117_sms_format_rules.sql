-- SMS Format Update: payment-SMS reading rules the Super Admin can update
-- from the dashboard when a provider changes its SMS wording, instead of
-- shipping a new Agent App build. Every saved format is kept as its own
-- version (never overwritten) so a previously working one can be restored;
-- at most one version per provider is active at a time. Additive only.
CREATE TABLE IF NOT EXISTS sms_format_rules (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  version INTEGER NOT NULL,
  sample_sms TEXT NOT NULL,
  pattern TEXT NOT NULL,
  amount_group INTEGER NOT NULL,
  sender_group INTEGER NOT NULL,
  reference_group INTEGER,
  recipient_group INTEGER,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  senders JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- What the sample produced when this version was saved (shown in history).
  extracted JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_by UUID,
  activated_at TIMESTAMPTZ,
  UNIQUE (provider, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_format_rules_one_active
  ON sms_format_rules (provider) WHERE status = 'active';

-- Who did what, and when: created / activated / restored / deactivated.
CREATE TABLE IF NOT EXISTS sms_format_rule_events (
  id UUID PRIMARY KEY,
  rule_id UUID REFERENCES sms_format_rules(id),
  provider TEXT NOT NULL,
  action TEXT NOT NULL,
  admin_id UUID,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_format_rule_events_provider ON sms_format_rule_events (provider, created_at DESC);
