#!/usr/bin/env python3
"""Render the video kit from the brand's own sources.

    python3 brand/video/generate.py

Marks come from brand/logo/*.svg via sharp (web/node_modules). Text is set in
JetBrains Mono from ~/.local/share/fonts, in the site's own colours read out
of web/src/app.css — so a change to --gold or the mark SVG propagates here by
re-running this, and nothing is redrawn by hand. Never edit the PNGs.
"""
import re, subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
LOGO, OUT = ROOT / "brand/logo", ROOT / "brand/video"
FONTS = Path.home() / ".local/share/fonts"
XB, B = FONTS / "JetBrainsMono-ExtraBold.ttf", FONTS / "JetBrainsMono-Bold.ttf"

css = (ROOT / "web/src/app.css").read_text()
def var(name, default):
    m = re.search(r"--%s\s*:\s*([^;]+);" % re.escape(name), css)
    return m.group(1).strip() if m else default
GOLD, BG = var("gold", "#ffd23f"), var("bg", "#07090d")
# "LASSE" in the wordmark is the share card's cream, sampled from og-card-3.png
# (243,230,196) — not a CSS variable, so it is pinned here.
CREAM = "#f3e6c4"
URL_GREY = (140, 140, 150)


def render_marks():
    node = f"""
const sharp=require({str(ROOT / 'web/node_modules/sharp')!r}); const fs=require("fs");
(async()=>{{
  await sharp(fs.readFileSync({str(LOGO / 'lassecash-mark.svg')!r}),{{density:288}}).resize(2048,2048).png().toFile({str(OUT / 'lassecash-mark-2048.png')!r});
  await sharp(fs.readFileSync({str(LOGO / 'lassecash-mark-glow.svg')!r}),{{density:288}}).resize(2048,2048).png().toFile({str(OUT / 'lassecash-mark-glow-2048.png')!r});
}})();"""
    subprocess.run(["node", "-e", node], check=True)


def spaced(d, xy, text, font, fill, spacing):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=font, fill=fill)
        x += d.textlength(ch, font=font) + spacing


def wordmark(width):
    """LASSECASH over ANCAP SOCIETY TOOLS, transparent, scaled from a 1920 design."""
    s = width / 1920
    big, tag = ImageFont.truetype(str(XB), int(150 * s)), ImageFont.truetype(str(B), int(44 * s))
    im = Image.new("RGBA", (width, int(300 * s)), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    w1, w2 = d.textlength("LASSE", font=big), d.textlength("CASH", font=big)
    x, y = (width - (w1 + w2)) / 2, int(20 * s)
    d.text((x, y), "LASSE", font=big, fill=CREAM)
    d.text((x + w1, y), "CASH", font=big, fill=GOLD)
    tagline, sp = "ANCAP SOCIETY TOOLS", int(0.18 * 44 * s)  # the header's 0.18em tracking
    tw = sum(d.textlength(c, font=tag) for c in tagline) + sp * (len(tagline) - 1)
    spaced(d, ((width - tw) / 2, y + int(175 * s)), tagline, tag, GOLD, sp)
    b = im.getbbox()
    return im.crop((0, b[1] - int(10 * s), width, b[3] + int(10 * s)))


def lockup():
    """Mark beside the wordmark, as the site header lays it out. 1920 wide."""
    mark = Image.open(OUT / "lassecash-mark-2048.png").convert("RGBA").resize((260, 260), Image.LANCZOS)
    big, tag = ImageFont.truetype(str(XB), 150), ImageFont.truetype(str(B), 34)
    im = Image.new("RGBA", (1920, 300), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    w1, w2 = d.textlength("LASSE", font=big), d.textlength("CASH", font=big)
    x0 = (1920 - (260 + 50 + w1 + w2)) / 2
    im.paste(mark, (int(x0), 20), mark)
    tx = x0 + 310
    d.text((tx, 30), "LASSE", font=big, fill=CREAM)
    d.text((tx + w1, 30), "CASH", font=big, fill=GOLD)
    spaced(d, (tx + 4, 208), "ANCAP SOCIETY TOOLS", tag, GOLD, int(0.18 * 34))
    b = im.getbbox()
    return im.crop((0, b[1] - 10, 1920, b[3] + 10))


def title_card():
    """1920x1080 intro / end card: the site's faint grid, glow mark, wordmark, url."""
    im = Image.new("RGBA", (1920, 1080), BG)
    d = ImageDraw.Draw(im)
    for gx in range(0, 1920, 48): d.line([gx, 0, gx, 1080], fill=(16, 19, 26))
    for gy in range(0, 1080, 48): d.line([0, gy, 1920, gy], fill=(16, 19, 26))
    glow = Image.open(OUT / "lassecash-mark-glow-2048.png").convert("RGBA").resize((340, 340), Image.LANCZOS)
    im.paste(glow, ((1920 - 340) // 2, 200), glow)
    wm = wordmark(1920)
    wm = wm.resize((1200, int(wm.size[1] * 1200 / 1920)), Image.LANCZOS)
    im.paste(wm, ((1920 - 1200) // 2, 570), wm)
    url = ImageFont.truetype(str(B), 34)
    d.text(((1920 - d.textlength("lassecash.com", font=url)) / 2, 940), "lassecash.com", font=url, fill=URL_GREY)
    return im.convert("RGB")


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    render_marks()
    for w in (1920, 3840):
        wordmark(w).save(OUT / f"wordmark-{w}.png")
    lockup().save(OUT / "lockup-1920.png")
    title_card().save(OUT / "title-card-1920x1080.png")
    print("video kit rendered:", sorted(p.name for p in OUT.glob("*.png")))
