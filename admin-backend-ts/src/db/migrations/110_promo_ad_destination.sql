-- Optional tap destination for a promo ad slide (Customer App's app-open
-- popup, PromoAdLaunchDialog). Previously the image/title/body were purely
-- informational -- tapping did nothing but swipe between slides. This lets
-- an agent configure either "go to this provider's packages" or "go to
-- this exact package", so a discount ad lands the customer directly on the
-- relevant service instead of Home.
--
-- destination_company_id/destination_package_id are ON DELETE SET NULL
-- (not RESTRICT/CASCADE): if the referenced company or package is later
-- deleted, the ad silently falls back to "no destination" (tap does
-- nothing but close the popup, same as today) rather than the delete
-- failing or the ad breaking. destination_type has no FK of its own; it's
-- just a discriminator for which of the two ids (if either) is meaningful.
ALTER TABLE promo_ads ADD COLUMN IF NOT EXISTS destination_type TEXT CHECK (destination_type IN ('company', 'package'));
ALTER TABLE promo_ads ADD COLUMN IF NOT EXISTS destination_company_id TEXT REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE promo_ads ADD COLUMN IF NOT EXISTS destination_package_id UUID REFERENCES packages(id) ON DELETE SET NULL;
