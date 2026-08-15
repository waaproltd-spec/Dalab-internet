-- Lets a customer set/replace/remove their own profile picture, uploaded the
-- same way Super Admin uploads a promo image (data URI -> raw bytes, see
-- promoImages.routes.ts and utils/dataUri.ts) rather than a new mechanism.
-- Stored directly on customers (one photo per customer, unlike the
-- multi-row/positioned promo_images table) and never selected by the
-- general customer column lists — only the dedicated profile-photo
-- read/write routes touch these two columns.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS photo_data BYTEA;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS photo_mime_type TEXT;
