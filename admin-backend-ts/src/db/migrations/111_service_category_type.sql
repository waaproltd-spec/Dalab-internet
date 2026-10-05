-- An Admin-only Service Type per service category, picked when the Admin
-- creates (or edits) a service: 'wifi' (home internet, e.g. Hormuud "5G
-- Home"), 'wireless' (mobile data, e.g. Somtel "Dhameys") or 'call'
-- (voice, e.g. Hormuud "Anfac"). The Customer App uses it only to choose
-- which icon to draw on the service's card -- customers are never asked to
-- pick a type. NULL for every existing category until an Admin sets one;
-- the app already falls back to its own icon for those.
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS service_type TEXT
  CHECK (service_type IN ('wifi', 'wireless', 'call'));
