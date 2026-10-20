#!/usr/bin/env python3
"""Render the A6 flyer (front + back) from the brand's own sources.

    python3 brand/flyer/generate.py

Print size: A6 portrait 105 x 148 mm, plus 3 mm bleed on every side
(111 x 154 mm) at 300 dpi = 1311 x 1819 px. Text and the QR sit inside a
9 mm safe margin from the edge of the file, so a cut that drifts by a
millimetre or two removes nothing that matters.

The QR points to https://lassecash.com/flyer — a bare redirect (web/src/routes/
flyer/+server.ts) whose only purpose is that Cloudflare counts the requests.
Colours come from web/src/app.css and the mark from brand/video, the same
sources the video kit uses, so nothing is redrawn by hand. Never edit the PNGs.
"""
import re
from pathlib import Path

import qrcode
import qrcode.constants as qc
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "brand/flyer"
FONTS = Path.home() / ".local/share/fonts"
XB, B, R = (FONTS / f"JetBrainsMono-{w}.ttf" for w in ("ExtraBold", "Bold", "Regular"))

css = (ROOT / "web/src/app.css").read_text()
def var(name, default):
    m = re.search(r"--%s\s*:\s*([^;]+);" % re.escape(name), css)
    return m.group(1).strip() if m else default
GOLD, BG = var("gold", "#ffd23f"), var("bg", "#07090d")
CREAM, GREY, CYAN = "#f3e6c4", "#9a9aa6", "#3fe0f0"

DPI = 300
W, H = round(111 / 25.4 * DPI), round(154 / 25.4 * DPI)   # 1311 x 1819
SAFE = round(9 / 25.4 * DPI)                              # 106 px
URL = "https://lassecash.com/flyer"


def font(path, size):
    return ImageFont.truetype(str(path), size)


def canvas():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    grid = (20, 24, 30)
    for x in range(0, W, 66):
        d.line([(x, 0), (x, H)], fill=grid, width=1)
    for y in range(0, H, 66):
        d.line([(0, y), (W, y)], fill=grid, width=1)
    return img, d


def centered(d, y, text, f, fill, spacing=0):
    """Draw `text` centred; `spacing` adds letter-spacing in px. Returns y after."""
    widths = [d.textlength(ch, font=f) for ch in text]
    total = sum(widths) + spacing * (len(text) - 1)
    x = (W - total) / 2
    for ch, w in zip(text, widths):
        d.text((x, y), ch, font=f, fill=fill)
        x += w + spacing
    asc, desc = f.getmetrics()
    return y + asc + desc


def wrap(d, text, f, width):
    lines, line = [], ""
    for word in text.split():
        trial = (line + " " + word).strip()
        if d.textlength(trial, font=f) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + [line]


def qr_plate(img, size, url=URL):
    q = qrcode.QRCode(error_correction=qc.ERROR_CORRECT_H, box_size=20, border=2)
    q.add_data(url)
    q.make(fit=True)
    code = q.make_image(fill_color="black", back_color="white").convert("RGB")
    code = code.resize((size, size), Image.NEAREST)
    pad = 28
    plate = Image.new("RGB", (size + 2 * pad, size + 2 * pad), "white")
    plate.paste(code, (pad, pad))
    return plate


def front():
    img, d = canvas()
    mark = Image.open(ROOT / "brand/video/lassecash-mark-2048.png").convert("RGBA")
    m = 200
    mark = mark.resize((m, m), Image.LANCZOS)
    img.paste(mark, ((W - m) // 2, SAFE + 10), mark)

    y = SAFE + 10 + m + 30
    y = centered(d, y, "LASSECASH", font(XB, 100), GOLD, spacing=4)
    y = centered(d, y + 4, "ANCAP SOCIETY TOOLS", font(B, 36), CYAN, spacing=8)

    y += 50
    big = font(XB, 150)
    for word, colour in (("Post.", CREAM), ("Vote.", CREAM), ("Get paid.", GOLD)):
        y = centered(d, y, word, big, colour) - 22

    plate = qr_plate(img, 340)
    py = H - SAFE - plate.height - 70
    img.paste(plate, ((W - plate.width) // 2, py))
    centered(d, py + plate.height + 14, "Scan to start  ·  lassecash.com", font(B, 40), CREAM)
    return img


def back():
    img, d = canvas()
    left, width = SAFE + 20, W - 2 * (SAFE + 20)
    y = SAFE + 10
    y = centered(d, y, "HOW IT WORKS", font(XB, 80), GOLD, spacing=6)
    y += 50

    steps = [
        ("1", "Write or vote.", "Post on LasseCash, or vote for what you value."),
        ("2", "Earn LASSECASH.", "Authors and voters are paid in the coin, from the protocol."),
        ("3", "Swap it.", "To HBD or Bitcoin, from your own wallet. No account, no exchange."),
    ]
    for num, head, body in steps:
        d.text((left, y), num, font=font(XB, 120), fill=GOLD)
        tx = left + 120
        d.text((tx, y + 4), head, font=font(XB, 66), fill=CREAM)
        by = y + 4 + 80
        for ln in wrap(d, body, font(R, 46), width - 120):
            d.text((tx, by), ln, font=font(R, 46), fill=GREY)
            by += 58
        y = max(by, y + 150) + 44

    d.line([(left, y), (W - left, y)], fill=GOLD, width=3)
    y += 36
    for ln in wrap(d, "Live on MAGI since 31 August 2026. Everything is public on the chain. "
                      "The pools are small, so start small.", font(R, 42), width):
        d.text((left, y), ln, font=font(R, 42), fill=CREAM)
        y += 54

    plate = qr_plate(img, 250)
    img.paste(plate, ((W - plate.width) // 2, y + 30))
    centered(d, H - SAFE - 135, "lassecash.com", font(XB, 88), GOLD)
    centered(d, H - SAFE - 28, "Post. Vote. Get paid.", font(B, 38), GREY)
    return img


if __name__ == "__main__":
    front().save(OUT / "flyer-front.png", dpi=(DPI, DPI))
    back().save(OUT / "flyer-back.png", dpi=(DPI, DPI))
    print("wrote", OUT / "flyer-front.png", OUT / "flyer-back.png", f"{W}x{H}")
