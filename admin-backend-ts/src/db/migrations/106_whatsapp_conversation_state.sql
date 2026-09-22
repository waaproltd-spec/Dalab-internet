CREATE TABLE IF NOT EXISTS whatsapp_conversation_state (
  phone       TEXT PRIMARY KEY,
  state       TEXT NOT NULL DEFAULT 'main' CHECK (state IN ('main', 'awaiting_order_id')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
