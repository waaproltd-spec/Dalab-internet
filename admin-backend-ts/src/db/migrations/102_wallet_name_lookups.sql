-- Wallet Name Lookup: verifies a customer-entered EVC Plus/eDahab number
-- against the carrier's own registered account name BEFORE it's saved as
-- one of the customer's Money Exchange wallets (see
-- customer-app/lib/screens/wallet_numbers_screen.dart's "Complete Account"
-- flow) -- the customer never types a name, only a number; the name shown
-- and ultimately saved always comes from this table's own verified
-- 'success' row, read live off the SIM via the same accessibility-service
-- mechanism Money Exchange payouts already use (see
-- agent-app's WalletLookupUssdOrchestrator), never a customer-supplied
-- string. This is a $1 "who would I be paying" USSD prompt read-only --
-- no PIN is ever entered and no money ever moves for a lookup (see that
-- orchestrator's own doc comment).
CREATE TABLE IF NOT EXISTS wallet_name_lookups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  wallet_id       TEXT NOT NULL REFERENCES payment_wallets(id) ON DELETE RESTRICT,
  phone_number    TEXT NOT NULL, -- bare 9-digit local number, same form exchange_orders.receiver_phone uses
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','claimed','success','not_found','failed')),
  registered_name TEXT, -- set only when status='success' -- the carrier's own text, never customer-supplied
  agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
  raw_response    TEXT, -- the carrier's full USSD reply text, for audit/debugging a parse failure
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wallet_name_lookups_status ON wallet_name_lookups(status);
CREATE INDEX IF NOT EXISTS idx_wallet_name_lookups_customer_id ON wallet_name_lookups(customer_id);
