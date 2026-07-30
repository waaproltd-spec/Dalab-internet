-- Reliability Dashboard: durable copy of the Agent App's local, on-device
-- DiagnosticsLog (heartbeat failures, background-service restarts/recovery
-- events, queue drops, etc.) so this survives beyond the device's own
-- capped local ring buffer. Delivery is best-effort — piggybacked onto the
-- existing heartbeat call, so an entry only lands here once a heartbeat
-- actually succeeds; until then it stays visible only on-device.
CREATE TABLE IF NOT EXISTS agent_diagnostics_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    TEXT REFERENCES agent_devices(id) ON DELETE CASCADE,
  tag          TEXT NOT NULL,
  message      TEXT NOT NULL,
  is_error     BOOLEAN NOT NULL DEFAULT true,
  occurred_at  TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_diagnostics_log_device ON agent_diagnostics_log(device_id, occurred_at DESC);
