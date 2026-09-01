-- 074_shop.sql seeded the Shop's first category as "Shoes" -- clothing/
-- footwear was never meant to be a Shop category (the spec-mandated set is
-- Electronics/Eyewear/Perfumes/Watches/Gifts). Renames that row in place so
-- its id, position, and any products/subcategories already referencing it
-- are undisturbed -- only name/emoji change. Matches on the exact old name,
-- so this is a no-op once applied (or if an Admin has since renamed the
-- category to something else themselves).
UPDATE shop_categories
SET name = 'Electronics', emoji = '📱', updated_at = now()
WHERE name = 'Shoes';
