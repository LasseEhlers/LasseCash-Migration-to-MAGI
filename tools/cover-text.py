#!/usr/bin/env python3
"""Put text on a post cover, correctly.

WHY THIS EXISTS. Image models cannot be trusted with text. On the burn-delay
cover, three attempts in a row produced "PAUSED TO SAVE VALUE. FUNDS ARE" with
the sentence cut off, a heading that would not go away, and a truncated
"BOOKS OWE 9,189,55". Numbers in a post about an accounting error have to be
right, and a model that drops a digit is worse than no text at all.

So: generate the picture with NO text, then run this. The letters are drawn by
a font, which spells what it is given.

    python3 tools/cover-text.py in.png out.png \
        --line "FOUND BEFORE THE KEYS BURNED" \
        --sub  "BOOKS OWE 9,189,552 - LEDGER HOLDS 166,665"

Gold on the headline, muted grey beneath, lower left, deliberately small — the
site's own rule is that glow is for hero numbers only, and a cover that shouts
reads as panic. A soft dark gradient goes behind the text so it stays legible
on a busy image without a hard box around it.
"""
import argparse
from PIL import Image, ImageDraw, ImageFont

GOLD = (212, 175, 55)
GREY = (170, 178, 189)
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("src"); p.add_argument("dst")
    p.add_argument("--line", required=True, help="headline, gold")
    p.add_argument("--sub", default="", help="second line, grey")
    p.add_argument("--scale", type=float, default=1.0, help="text size multiplier")
    a = p.parse_args()

    im = Image.open(a.src).convert("RGB")
    W, H = im.size
    # Sized from the image, not in absolute pixels, so the same command works
    # whatever the model hands back.
    head = ImageFont.truetype(BOLD, int(W * 0.028 * a.scale))
    sub = ImageFont.truetype(MONO, int(W * 0.0165 * a.scale))
    pad = int(W * 0.035)

    hb = head.getbbox(a.line)
    sb = sub.getbbox(a.sub) if a.sub else (0, 0, 0, 0)
    gap = int(W * 0.012)
    block = (hb[3] - hb[1]) + (gap + (sb[3] - sb[1]) if a.sub else 0)
    top = H - pad - block

    # A gradient rather than a box: legible without looking pasted on.
    shade = Image.new("L", (1, H), 0)
    for y in range(H):
        t = max(0.0, (y - (top - pad)) / max(1, H - (top - pad)))
        shade.putpixel((0, y), int(150 * t * t))
    im = Image.composite(Image.new("RGB", im.size, (0, 0, 0)), im,
                         shade.resize(im.size))

    d = ImageDraw.Draw(im)
    d.text((pad, top - hb[1]), a.line, font=head, fill=GOLD)
    if a.sub:
        d.text((pad, top + (hb[3] - hb[1]) + gap - sb[1]), a.sub, font=sub, fill=GREY)

    im.save(a.dst, quality=95)
    print(f"wrote {a.dst}  ({W}x{H})")
    print(f"  gold: {a.line}")
    if a.sub:
        print(f"  grey: {a.sub}")


if __name__ == "__main__":
    main()
