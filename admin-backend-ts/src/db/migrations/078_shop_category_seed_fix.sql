-- Fixes shop_categories rows still carrying the pre-spec-lock "Shoes"
-- name/emoji from an early draft seed, before the fixed 5-category list
-- was finalized to Electronics/Eyewear/Perfumes/Watches/Gifts (see
-- 074_shop_schema.sql). 074's seed INSERT uses ON CONFLICT (id) DO
-- NOTHING, so any environment where a row for id='electronics' already
-- existed with the old name never picked up the corrected seed value.
-- Only touches rows still carrying the exact old value, so an Admin who
-- has since deliberately renamed this category is left untouched.
UPDATE shop_categories
SET name = 'Electronics', emoji = '📱', updated_at = now()
WHERE id = 'electronics' AND name = 'Shoes';
