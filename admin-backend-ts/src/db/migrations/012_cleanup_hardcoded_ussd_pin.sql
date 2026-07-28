-- Removes the literal "8233" that was mistakenly hardcoded directly in front
-- of the {pin} placeholder in USSD templates (an admin data-entry mistake
-- that duplicated the then-current PIN value into the template pattern
-- itself, causing generated USSD strings to dial those digits twice, e.g.
-- "*737*610346060*0.09*82338233#"). Only the exact "8233{pin}" substring is
-- targeted and replaced with "{pin}" alone — the placeholder itself, the
-- rest of the pattern, and every other field (payment numbers, actual PINs)
-- are untouched. Idempotent: once no ussd_code contains "8233{pin}" this is
-- a no-op on every subsequent deploy. Applies to every provider's templates
-- (Hormuud, Somnet, Somtel, Amtel), not a specific company_id, since the
-- mistake wasn't provider-specific.
UPDATE ussd_templates SET ussd_code = REPLACE(ussd_code, '8233{pin}', '{pin}'), updated_at = now()
WHERE ussd_code LIKE '%8233{pin}%';
