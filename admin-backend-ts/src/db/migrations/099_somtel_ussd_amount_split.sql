-- Fixes a real stuck order (DLB637490120, Somtel "Unlimited Data & Voice",
-- $17.50 provider amount): every Somtel USSD template dials the amount as
-- {amount} -- a single concatenated token ("175") -- but Somtel's *83x*
-- top-up menu actually needs the whole-dollar figure and the cents as
-- separate dial-string fields, omitting the cents field entirely for a
-- whole-dollar amount ("17" for $17.00, "17*5" for $17.50, never "175",
-- "17.5", or "17*50"). See ussdFormatting.ts's formatUssdAmountSplit for
-- the exact rule and the {amountSplit} placeholder that applies it.
--
-- Scoped to every currently-Somtel template sharing this shape (Unlimited
-- Data & Voice, No Expire, Unlimited Calls, Voice, and any future one saved
-- the same way) rather than only the one package that happened to fail --
-- they all dial through the same carrier menu family (same trailing
-- "8233{pin}" selector), so the same bug applies to all of them whenever
-- their amount isn't a whole dollar. Hormuud and Amtel's templates are
-- deliberately left untouched: their single-token {amount} form is
-- separately confirmed correct against real completed orders (see
-- ussdFormatting.ts's own header comment) -- this migration only ever
-- touches company_id='somtel'.
UPDATE ussd_templates
SET ussd_code = REPLACE(ussd_code, '{amount}', '{amountSplit}'), updated_at = now()
WHERE company_id = 'somtel' AND ussd_code LIKE '%{amount}%';
