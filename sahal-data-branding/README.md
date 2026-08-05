# Sahal Data brand mark

`logo-mark.png` is the source artwork for the Sahal Data logo used across
every app in this rebrand — a two-tone swirl "S" (blue `#1B368D`, orange
`#E99D13`) on a transparent background.

All launcher icons, favicons, and the Super Admin dashboard logo are
generated from this single file by compositing it onto a white
rounded-square (or circle, for Android's `_round` variants) at the size
each platform needs — see `sahal-data-customer-app/public/logo-mark.png`
for the transparent, un-composited copy embedded directly in the customer
web app's login/OTP screens.

## Brand colors

| Token | Hex | Used for |
|---|---|---|
| Blue (primary) | `#1B368D` | Buttons, headers, active nav, primary chrome |
| Blue, dark | `#132766` | Gradient partner / darker chrome |
| Blue, light | `#274ECC` | Gradient partner / lighter chrome |
| Orange (accent) | `#E99D13` | Secondary buttons, highlights, the logo's arrow |
| Orange, dark | `#C68510` | Gradient partner for the orange accent |

Existing multi-color status/semantic systems (order status pills, "enabled
vs. disabled" indicators, reliability dashboards, and so on) were
deliberately **left on their original green/red/amber palette** — those
colors encode meaning (success/failure/warning), not brand identity, and
recoloring them to orange would make "success" and "warning" harder to
tell apart at a glance. Real third-party brand colors (e.g. Hormuud's own
green, used for its EVC Plus payment method) were left untouched for the
same reason: they represent that company's identity, not Sahal Data's.

Regenerate every PNG after editing `logo-mark.png` — see
`gen_icons2.py`-style compositing (white/rounded-square or circular mask,
mark scaled to ~82% of the canvas) in git history for the exact recipe.
