-- Private Friend system: every customer gets a permanent, unique, short
-- Friend ID (e.g. "DALAB-7K29") that is the ONLY way another customer can
-- find them -- there is deliberately no customer directory/search-by-name
-- anywhere in this feature (see friends.routes.ts GET /customer/friends/search,
-- which only ever returns an exact friend_code match), so a customer's
-- presence in the app is never exposed to anyone who doesn't already have
-- their code. Ambiguous-looking characters (0/O, 1/I) are excluded from the
-- code alphabet so a customer reading their own code aloud, or typing one a
-- friend read out to them, never trips over a character that looks like
-- another.
CREATE OR REPLACE FUNCTION generate_friend_code() RETURNS TEXT AS $$
DECLARE
  chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code TEXT;
BEGIN
  LOOP
    code := 'DALAB-' || (
      SELECT string_agg(substr(chars, (floor(random() * length(chars)) + 1)::int, 1), '')
      FROM generate_series(1, 4)
    );
    EXIT WHEN NOT EXISTS (SELECT 1 FROM customers WHERE friend_code = code);
  END LOOP;
  RETURN code;
END;
$$ LANGUAGE plpgsql;

-- Split into three steps rather than one ADD COLUMN ... DEFAULT
-- generate_friend_code() -- a volatile default on ADD COLUMN forces Postgres
-- to rewrite the whole table there and then, evaluating the function once
-- per existing row while that same table is mid-rewrite; generate_friend_code()
-- self-queries `customers` for its uniqueness check, and querying a table
-- from inside its own bulk rewrite is exactly the kind of self-reference
-- that corrupted this step in testing (a low-level "could not read block"
-- I/O error). Plain UPDATEs after the column already exists don't have that
-- problem, so: (1) add the bare column, (2) backfill every existing row one
-- UPDATE at a time, (3) add the uniqueness/NOT NULL constraints and the
-- DEFAULT for future signups -- by then generate_friend_code() runs at
-- ordinary INSERT time, not during a table rewrite, which is the safe,
-- standard case.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS friend_code TEXT;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM customers WHERE friend_code IS NULL LOOP
    UPDATE customers SET friend_code = generate_friend_code() WHERE id = r.id;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_friend_code_key'
  ) THEN
    ALTER TABLE customers ADD CONSTRAINT customers_friend_code_key UNIQUE (friend_code);
  END IF;
END $$;

ALTER TABLE customers ALTER COLUMN friend_code SET NOT NULL;
ALTER TABLE customers ALTER COLUMN friend_code SET DEFAULT generate_friend_code();

-- One row per friend request, from first send through its final outcome --
-- 'pending' can resolve to 'accepted' (this row becomes that friendship's
-- permanent identity -- see friend_messages below, which references it
-- directly rather than through a separate friendships table), 'declined',
-- 'cancelled' (the requester withdrew it before the recipient responded),
-- or 'blocked' (either side blocked the other -- see the app-level check in
-- friends.routes.ts that also forecloses any new request between a pair
-- with a 'blocked' row, since the partial unique index below only covers
-- 'pending').
CREATE TABLE IF NOT EXISTS friend_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  recipient_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','declined','cancelled','blocked')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at   TIMESTAMPTZ,
  CHECK (requester_id != recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_requests_requester ON friend_requests(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient ON friend_requests(recipient_id, status);
-- At most one live (pending) request between any two customers regardless
-- of who sent it -- same "DB constraint, not just app-level discipline"
-- pattern as support_conversations' one-open-per-customer index.
-- LEAST/GREATEST collapse (A,B) and (B,A) onto the same key so a request
-- already pending in one direction blocks a duplicate started in the other,
-- including under a concurrent double-submit race.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pending_pair
  ON friend_requests (LEAST(requester_id, recipient_id), GREATEST(requester_id, recipient_id))
  WHERE status = 'pending';

-- Private 1-to-1 chat, unlocked only once its friend_requests row is
-- 'accepted' (see POST .../messages' status check in friends.routes.ts).
-- friend_request_id doubles as the friendship's own id -- there is no
-- separate friendships table, the same "this row IS the relationship"
-- pattern support_conversations/support_messages already uses.
CREATE TABLE IF NOT EXISTS friend_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  friend_request_id UUID NOT NULL REFERENCES friend_requests(id) ON DELETE CASCADE,
  sender_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  body              TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_friend_messages_request ON friend_messages(friend_request_id, created_at);

-- notifications.type is whitelisted by a CHECK constraint -- widen it to
-- also accept this feature's three new types ('friend_request',
-- 'friend_accepted', 'friend_message', all written by notifyCustomer() in
-- friends.routes.ts). Recreated NOT VALID, matching how the existing
-- constraint is already declared, so this doesn't force a full-table
-- validation scan of every historical notifications row.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (
  type = ANY (ARRAY[
    'push','promotion','maintenance','feedback_update','exchange_update','order_update','campaign',
    'shop_order_update','shop_return_update','shop_back_in_stock','vip_number_order_update','vip_number_package_order_update',
    'friend_request','friend_accepted','friend_message'
  ])
) NOT VALID;

-- notifyCustomer() (customerNotify.ts) already builds a `data` payload for
-- every push it sends (screen, ids to deep-link with) but previously only
-- forwarded it to FCM, never persisted it -- so the in-app notifications
-- list had no way to know WHICH friend_requests row a "friend_request"
-- notification was about. Storing it here lets the customer app's
-- notification card offer Aqbal/Diid inline, and is generically useful for
-- any other notification type's routing info too.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data JSONB;
