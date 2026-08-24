-- Adds image/voice message support to the existing Agent Support
-- conversation system (support_messages) -- same table, same real-time
-- broadcast, same queue/claim/resolve logic, no separate chat system.
--
-- Message content here is intentionally EPHEMERAL: support.routes.ts hard-
-- deletes every support_messages row for a conversation the instant it ends
-- (resolved, closed, or customer-cancelled) -- see endConversationAndAutoClaim
-- and the customer-facing /cancel handler. Storing media as BYTEA on the
-- message row itself (same pattern promo_images already uses for images)
-- means that single DELETE removes the media bytes along with the text --
-- no separate blob-storage cleanup step to keep in sync. While a
-- conversation is still open, messages are ordinary rows: the existing
-- poll-based (customer) and SSE-triggered-refetch (agent) sync both depend
-- on the server having somewhere to hold a message between one side sending
-- it and the other side's next read, exactly like text messages already do.

ALTER TABLE support_messages ALTER COLUMN body DROP NOT NULL;

ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE support_messages DROP CONSTRAINT IF EXISTS support_messages_message_type_check;
ALTER TABLE support_messages ADD CONSTRAINT support_messages_message_type_check
  CHECK (message_type IN ('text','image','voice'));

ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS media_data BYTEA;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS media_mime_type TEXT;

-- A text message must have a body; an image/voice message must have media.
-- Safe to replay: every existing row is message_type='text' with body
-- already NOT NULL (the column's original constraint, only just relaxed
-- above), so 100% of current data satisfies this the moment it's first
-- applied -- and nothing after this migration ever narrows it further the
-- way 041_money_exchange.sql's notifications_type_check once did, so this
-- constraint has no equivalent replay hazard.
ALTER TABLE support_messages DROP CONSTRAINT IF EXISTS support_messages_content_check;
ALTER TABLE support_messages ADD CONSTRAINT support_messages_content_check
  CHECK (
    (message_type = 'text' AND body IS NOT NULL)
    OR (message_type IN ('image','voice') AND media_data IS NOT NULL)
  );
