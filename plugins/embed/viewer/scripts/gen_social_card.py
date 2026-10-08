#!/usr/bin/env python3
"""Render the album graph viewer's social card (static/social-card.png).

The design is adapted from the blog's Open Graph cards
(blog.finnrut.is, scripts/gen_og_cards.py in the blog repo): same 2400x1260
canvas, dark paper, accent band, Cooper faces, muted meta line, and a
hostname wordmark bottom-right. The blog's per-post chrome (date chips,
reading time) makes no sense for a tool, so this card keeps the site-wide
default layout and adds a quiet constellation of connected points along the
top — the graph the viewer draws, in the viewer's own community palette.
No album artwork or library data appears on the card.

Fonts are the committed Cooper TTF faces in fonts/cooper/ (SIL OFL 1.1, see
fonts/cooper/LICENSE.md), converted once from the blog's woff2 with
woff2_decompress because Pillow cannot read woff2. Everything else is stock
Pillow; regenerate with any Python 3 that has Pillow installed, e.g.:

    cd plugins/embed/viewer
    python3 scripts/gen_social_card.py

(The beets-plugins dev shell's Pillow currently fails to import its compiled
core; the blog repo's dev shell — `nix develop --ignore-environment <blog>`
— ships a working one and renders this exact card.)

Layout is deterministic (fixed seed): re-running with the same Pillow version
reproduces the card byte for byte.
"""

import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Palette — the viewer's own chrome colors (style.css), which mirror the
# blog's dark theme; keep both in sync. Dark rather than light because the
# card sits inside someone else's timeline (see the blog's generator).
PAPER = (28, 25, 21)      # --paper   #1c1915
ACCENT = (255, 158, 66)   # --accent  #ff9e42
INK = (232, 226, 216)     # --ink     #e8e2d8
MUTED = (158, 148, 134)   # --muted   #9e9486

# The viewer's community colors (style.css --community-*), used for the
# constellation nodes so the card quotes the map itself.
COMMUNITY = [
    (254, 128, 25),   # orange  #fe8019
    (131, 165, 152),  # blue    #83a598
    (211, 134, 155),  # purple  #d3869b
    (184, 187, 38),   # green   #b8bb26
    (251, 73, 52),    # red     #fb4934
    (142, 192, 124),  # aqua    #8ec07c
    (250, 189, 47),   # yellow  #fabd2f
]

# Canvas. 1200x630 is the Open Graph minimum; render at 2x so the card is
# natively sharp on high-density timelines, and declare the true size in
# index.html's og:image dimensions.
SCALE = 2
BASE_W, BASE_H = 1200, 630
W, H = BASE_W * SCALE, BASE_H * SCALE
MARGIN = 80 * SCALE
BAND_H = 18 * SCALE       # accent band thickness across the top
CONTENT_W = W - 2 * MARGIN

TITLE_MAX = 148 * SCALE   # short tool name: start at display size, shrink to fit
TITLE_MIN = 50 * SCALE
TITLE_STEP = 2 * SCALE
TITLE_LINE_RATIO = 1.12

DESC_SIZE = 34 * SCALE
DESC_MAX_LINES = 2
DESC_LINE_RATIO = 1.30
DESC_GAP = 30 * SCALE

META_SIZE = 34 * SCALE
SITE_SIZE = 32 * SCALE
BODY_BOTTOM_GAP = 32 * SCALE

# Card copy. The title is the public instance's name and the subtitle its
# invitation; the meta line and wordmark carry whose and where, matching the
# blog's attribution pattern.
TITLE = "Finn's Library"
DESCRIPTION = "Explore my music collection"
META = "FINN RUTIS  ·  Interactive music map"
SITE = "albums.finnrut.is"

FONT_DIR = Path(__file__).parent / "fonts" / "cooper"
OUT = Path(__file__).parents[1] / "static" / "social-card.png"

# Flat color plus antialiased text palette-quantizes losslessly to the eye;
# only cross the threshold into quantization when a render grows past it.
MAX_BYTES = 600 * 1024
QUANTIZE_COLORS = 64


def lerp(a, b, t):
    """Blend two RGB tuples; used to derive quiet colors from the palette."""
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


SECONDARY = lerp(MUTED, INK, 0.4)


def load_font(name, size):
    return ImageFont.truetype(str(FONT_DIR / name), size)


def text_w(draw, text, font):
    return draw.textlength(text, font=font)


def wrap(draw, text, font, max_w):
    """Greedy word wrap to max_w pixels. Returns list of lines."""
    words = text.split()
    lines, cur = [], ""
    for word in words:
        trial = f"{cur} {word}".strip()
        if text_w(draw, trial, font) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def fit_title(draw, text, avail_h):
    """Shrink the unwrapped title until its measured bounds fit the space."""
    for size in range(TITLE_MAX, TITLE_MIN - 1, -TITLE_STEP):
        font = load_font("Cooper-Black.ttf", size)
        left, _, right, _ = draw.textbbox((0, 0), text, font=font, anchor="la")
        block_h = int(size * TITLE_LINE_RATIO)
        if (0 <= left and right <= CONTENT_W
                and text_w(draw, text, font) <= CONTENT_W and block_h <= avail_h):
            return font, [text]
    raise ValueError("Title cannot fit on one line within the available space")


def fit_description(draw, text, font, max_lines):
    """Wrap to at most max_lines, ellipsising the last line if it overflows."""
    lines = wrap(draw, text, font, CONTENT_W)
    if len(lines) <= max_lines:
        return lines
    lines = lines[:max_lines]
    last = lines[-1]
    while last and text_w(draw, last + "…", font) > CONTENT_W:
        last = last.rsplit(" ", 1)[0] if " " in last else last[:-1]
    lines[-1] = last.rstrip(" ,;:.") + "…"
    return lines


def draw_constellation(draw):
    """A quiet band of connected points under the accent strip.

    Deterministic (seeded) so regeneration is stable. Nodes take the viewer's
    community colors, dimmed toward the paper so the title stays the loudest
    thing on the card; links are dimmer still, like the map's base edges.
    """
    rng = random.Random(20261008)
    zone_left, zone_right = W * 0.52, W - MARGIN
    zone_top, zone_bottom = 60 * SCALE, 140 * SCALE
    nodes = [
        (rng.uniform(zone_left, zone_right), rng.uniform(zone_top, zone_bottom))
        for _ in range(18)
    ]
    link_color = lerp(PAPER, MUTED, 0.55)
    for i, (x1, y1) in enumerate(nodes):
        # Connect each point to its two nearest neighbors, like the map's
        # nearest-neighbor edges; cap the length so the band stays airy.
        nearest = sorted(
            ((abs(x1 - x2) + abs(y1 - y2), j) for j, (x2, y2) in enumerate(nodes) if j != i)
        )[:2]
        for distance, j in nearest:
            if j > i and distance < 210 * SCALE:
                x2, y2 = nodes[j]
                draw.line([x1, y1, x2, y2], fill=link_color, width=2 * SCALE)
    for i, (x, y) in enumerate(nodes):
        color = lerp(PAPER, COMMUNITY[i % len(COMMUNITY)], 0.85)
        radius = rng.uniform(3.0, 5.5) * SCALE
        draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color)


def render_card(out_path):
    img = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(img)

    # Accent band across the top.
    draw.rectangle([0, 0, W, BAND_H], fill=ACCENT)
    draw_constellation(draw)

    meta_font = load_font("Cooper-Regular.ttf", META_SIZE)
    desc_font = load_font("Cooper-Regular.ttf", DESC_SIZE)

    # Bottom row first — whatever it claims is off-limits to the title block.
    meta_zone_top = H - MARGIN - META_SIZE
    body_top = BAND_H + MARGIN
    body_bottom = meta_zone_top - BODY_BOTTOM_GAP
    body_h = body_bottom - body_top

    title_font, lines = fit_title(draw, TITLE, body_h)
    line_h = int(title_font.size * TITLE_LINE_RATIO)
    block_h = line_h * len(lines)

    # Description fills the empty middle that the short title leaves behind.
    desc_lines = []
    desc_line_h = int(DESC_SIZE * DESC_LINE_RATIO)
    if DESCRIPTION:
        room = body_h - block_h - DESC_GAP
        allowed = min(DESC_MAX_LINES, room // desc_line_h)
        if allowed >= 1:
            desc_lines = fit_description(draw, DESCRIPTION, desc_font, int(allowed))
            block_h += DESC_GAP + desc_line_h * len(desc_lines)

    y = body_top + max(0, (body_h - block_h) // 2)
    for line in lines:
        draw.text((MARGIN, y), line, font=title_font, fill=ACCENT, anchor="la")
        y += line_h
    if desc_lines:
        y += DESC_GAP
        for line in desc_lines:
            draw.text((MARGIN, y), line, font=desc_font, fill=SECONDARY, anchor="la")
            y += desc_line_h

    # Meta line and site identity share a baseline at the bottom margin, so the
    # attribution travels with a card that gets reshared without its link.
    baseline = H - MARGIN
    draw.text((MARGIN, baseline), META, font=meta_font, fill=SECONDARY, anchor="ls")
    site_font = load_font("Cooper-Bold.ttf", SITE_SIZE)
    draw.text((W - MARGIN, baseline), SITE, font=site_font, fill=ACCENT, anchor="rs")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "PNG", optimize=True)
    if out_path.stat().st_size > MAX_BYTES:
        img.quantize(colors=QUANTIZE_COLORS).save(out_path, "PNG", optimize=True)
    print(f"{out_path}  {out_path.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    render_card(OUT)
