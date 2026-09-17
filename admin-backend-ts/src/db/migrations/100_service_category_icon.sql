-- Lets a Super Admin/Admin upload a real icon/logo per service category
-- (Adsl Plus, Anfac, Unlimited Calls, ...) from the dashboard instead of
-- every category being permanently stuck with whatever bundled icon the
-- Customer/Agent app ships with. Same storage shape as companies.logo_data/
-- logo_mime_type (an uploaded image, served back via its own dedicated
-- route) -- nothing else about service_categories changes, and every
-- existing category keeps working exactly as before (both columns default
-- to NULL, which the app already knows how to fall back from).
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS icon_data BYTEA;
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS icon_mime_type TEXT;
