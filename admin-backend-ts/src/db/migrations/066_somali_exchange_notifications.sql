-- Backfills existing Money Exchange notifications (notifications.type =
-- 'exchange_update') from their original English title/body to Somali,
-- matching the exact translations exchange.routes.ts's notifyCustomer()
-- calls now generate for every *new* notification going forward. Only
-- rewrites title/body text on rows whose content still exactly matches the
-- OLD English wording -- id, type, customer_id, sent_at, and every other
-- column/row are untouched, and no rows are deleted.
--
-- Safe to replay: once a row's title/body has been rewritten to Somali, it
-- no longer matches the English WHERE clause below, so re-running this file
-- on the next deploy (migrate.ts replays every migration file every time,
-- no tracking table) is a no-op for already-migrated rows.
--
-- Three of the five notification texts embed dynamic values (amount, phone
-- number) via string interpolation at the moment they were first inserted --
-- e.g. "Your exchange of 4.00 is complete — 252619991299 received 3.96." --
-- so those can't be fixed-string replaced; a targeted regexp_replace
-- reconstructs the Somali sentence around the exact same captured values,
-- changing nothing but the surrounding wording.

-- "Exchange failed" -- fully static text, no dynamic values.
UPDATE notifications
SET title = 'Sarrifku wuu fashilmay',
    body = 'Ma awoodin inaan dhammaystirno sarrifkaaga. Fadlan la xiriir Taageerada si laguu caawiyo.'
WHERE type = 'exchange_update'
  AND title = 'Exchange failed'
  AND body = 'We couldn''t complete your exchange. Please contact support for assistance.';

-- "Exchange cancelled" -- fully static text, no dynamic values.
UPDATE notifications
SET title = 'Sarrifka waa la joojiyay',
    body = 'Codsigaaga sarrifku waa la joojiyay. Haddii aad su''aalo qabto, fadlan la xiriir Taageerada.'
WHERE type = 'exchange_update'
  AND title = 'Exchange cancelled'
  AND body = 'Your exchange request was cancelled. Please contact support if you have questions.';

-- "Your money exchange is complete" -- "Your exchange of X is complete — Y received Z."
UPDATE notifications
SET title = 'Sarrifka lacagtaada waa la dhammaystiray',
    body = regexp_replace(
      body,
      '^Your exchange of (.+) is complete — (.+) received (.+)\.$',
      'Sarrifkaaga \1 waa la dhammaystiray — \2 waxaa loo diray \3.'
    )
WHERE type = 'exchange_update'
  AND title = 'Your money exchange is complete'
  AND body ~ '^Your exchange of (.+) is complete — (.+) received (.+)\.$';

-- "Payment verified" -- "We've received your payment of X — your exchange is now being processed."
UPDATE notifications
SET title = 'Lacag-bixinta waa la xaqiijiyey',
    body = regexp_replace(
      body,
      '^We''ve received your payment of (.+) — your exchange is now being processed\.$',
      'Waxaan helnay lacag-bixintaada oo ah \1 — sarrifkaaga hadda waa la farsamaynayaa.'
    )
WHERE type = 'exchange_update'
  AND title = 'Payment verified'
  AND body ~ '^We''ve received your payment of (.+) — your exchange is now being processed\.$';

-- "Exchange request received" -- "Your request to exchange X is being reviewed. We'll notify you once your payment is verified."
UPDATE notifications
SET title = 'Codsiga sarrifka waa la helay',
    body = regexp_replace(
      body,
      '^Your request to exchange (.+) is being reviewed\. We''ll notify you once your payment is verified\.$',
      'Codsigaaga sarrifka \1 ayaa dib loo eegayaa. Waxaan ku ogeysiin doonaa marka lacag-bixintaada la xaqiijiyo.'
    )
WHERE type = 'exchange_update'
  AND title = 'Exchange request received'
  AND body ~ '^Your request to exchange (.+) is being reviewed\. We''ll notify you once your payment is verified\.$';
