# Sahal Data brand mark

`logo.svg` is the source of the Sahal Data logo used across every app in
this rebrand: a white "S" with ascending green signal bars on an indigo
badge (`#1D2E8C` → `#16209E` gradient, accent `#22B24C`).

All PNG launcher icons, favicons, and the Super Admin dashboard logo are
rendered from this single SVG at the sizes each platform needs. Regenerate
them after editing the SVG, e.g. with `cairosvg`:

```
python3 -c "import cairosvg; cairosvg.svg2png(url='logo.svg', write_to='logo.png', output_width=512, output_height=512)"
```

Replace this SVG with professional artwork whenever you have it — every
generated PNG in the other app directories should be re-rendered from
whatever file takes its place here.
