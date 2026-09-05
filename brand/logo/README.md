# LasseCash logo files — for listing sites, wallets and link previews

**The logo is the square mark** — a gold L in a gold-bordered rounded square on
near-black, the same geometry as the site header and favicon. Lasse's call,
2026-09-05: the new mark everywhere, one identity for the MAGI era. The source
of truth is the vector, `lassecash-mark.svg`; every PNG here is rendered from
it with sharp at native size (not downscaled), so edges are crisp at 32px.

| File | Use |
|---|---|
| `lassecash-512.png` | CoinGecko / CoinMarketCap / CoinPaprika / LiveCoinWatch upload (they downscale) |
| `lassecash-256.png` · `lassecash-200.png` · `lassecash-128.png` | forms that cap the upload size |
| `lassecash-64.png` · `lassecash-32.png` | wallets, list rows |
| `lassecash-mark.svg` | the vector; give this to anyone who asks for "the logo" |
| `lassecash-roundel-legacy-512.png` | the pre-2026 gold coin roundel Hive-Engine served as the token icon — reference only, not for new listings |

Served from the site as well, so a form that wants a URL rather than an upload
gets one that will not move:

- https://lassecash.com/logo/lassecash-512.png
- https://lassecash.com/logo/lassecash-256.png
- https://lassecash.com/logo/lassecash-200.png
- https://lassecash.com/logo/lassecash-mark.svg

Corners are transparent (the square is rounded), so it sits cleanly on light or
dark backgrounds. Sites that mask logos to a circle will clip the border's
corners; if that ever bothers, render a circular variant from the same SVG
rather than reaching for the old roundel.

Regenerate from the SVG with sharp; do not edit the PNGs by hand.
