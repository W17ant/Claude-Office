#!/usr/bin/env python3
"""
walk-cycle.py - give a character sprite its four-frame walk cycle (src/walk.ts).

A character walks by looping four frames per direction (left foot down,
passing, right foot down, passing), saved beside its standing sprites as
<name>-<direction>-walk1.webp .. -walk4.webp. A sprite without all four
glides as before. Walking uses three directions (front-left, front-right,
rear-left; rear-right is only ever seen standing), so one ChatGPT image, a
3 x 4 grid on a magenta background, makes the whole cycle.

  1. python3 scripts/walk-cycle.py prepare MyChar-1
       writes MyChar-1-walk-input.png (the three standing poses side by
       side on magenta) and prints the prompt to give ChatGPT with it
  2. upload that image to ChatGPT with the prompt, save its answer
  3. python3 scripts/walk-cycle.py cut answer.png MyChar-1
       cuts the 12 figures out and writes the 12 frames beside the sprites

Options (both commands):
  --dir DIR     where the sprites are (default public/sprites/characters)
  --festive     the Christmas copy instead: animate <name>-<dir>-xmas.webp,
                write <name>-<dir>-xmas-walk1.webp ..
  --no-mirror   (cut) never flip a row; for an outfit with words on it

  python3 scripts/walk-cycle.py prompt [--festive] prints just the prompt.

Each frame is drawn on its standing sprite's canvas, its feet where the
standing pose's feet are, one scale per direction (the row's tallest frame
to the standing height, so the body bobs as ChatGPT drew it), and saved 200
px tall as WebP (the office draws characters ~80 px tall). A row ChatGPT drew
facing the wrong way is mirrored, judged by how the upper body overlaps the
standing pose. Needs Pillow and numpy (pip3 install Pillow numpy).
"""

import argparse
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:
    # Why not exit here: `prompt` needs neither; prepare and cut check (need_images)
    np = Image = None


def need_images():
    if np is None or Image is None:
        sys.exit("Error: Pillow and numpy are required. Install with: pip3 install Pillow numpy")

ROOT = Path(__file__).resolve().parent.parent
DIRS = ["front-left", "front-right", "rear-left"]
OUT_H = 200  # Why: drawn ~80 px tall; ~2.4x keeps it sharp on 2x screens and public/ in budget

PROMPT = (
    "This is a pixel-art game character standing in 3 directions (left figure, middle figure, right figure). "
    "Make a 4-frame looping WALK CYCLE sprite sheet of the SAME character: 3 ROWS and 4 COLUMNS. "
    "Row 1 = the left figure's direction, row 2 = the middle figure's direction, row 3 = the right figure's direction. "
    "The 4 columns are the 4 phases of the walk, left to right: "
    "1 = contact: left foot forward with its heel on the ground, right foot back, right arm swung forward; "
    "2 = passing: legs together under the body, right foot lifted a little as it passes, arms by the sides; "
    "3 = contact: right foot forward, left foot back, left arm swung forward; "
    "4 = passing: legs together, left foot lifted a little, arms by the sides. "
    "Small natural steps, feet never wider apart than the shoulders. "
    "In every frame the head and torso face EXACTLY the same angle as that row's standing figure: "
    "do not turn the head, do not turn the body sideways, only the legs and arms move. "
    "Same size and proportions as the standing figures, same clothes, face, hair, accessories and shoes, "
    "same pixel-art style, outline and shading. "
    "Row 3 walks AWAY from the viewer like the right standing figure: in all 4 frames of row 3 we see "
    "the back of the head and the back, never the face. "
    "All 12 figures the same height, feet on one baseline per row. Leave clear magenta gaps between all 12 figures. "
    "Flat solid magenta (#FF00FF) background everywhere, no shadows, no grid lines, no labels, no added text."
)
FESTIVE_PROMPT_EXTRA = (
    " Keep the Christmas outfit exactly as it is: same jumper pattern and colours, any hat or costume, "
    "and any words on the jumper stay the same and read the right way round."
)

# ---------------------------------------------------------------------------
# The magenta key
# ---------------------------------------------------------------------------

MAGENTA = (255.0, 0.0, 255.0)
# Why distance to pure magenta: a "red and blue above green" test also takes
# purple and pink clothes; ChatGPT's backdrop sits within ~10 of pure magenta,
# the darkest purple cloth ~120 away
KEY_LO, KEY_HI = 35, 80


def key(rgb):
    """RGB uint8 array -> RGBA uint8: the backdrop transparent, outline pixels unmixed from it."""
    m = np.array(MAGENTA, np.float32)
    a = rgb.astype(np.float32)
    d = np.sqrt(((a - m) ** 2).sum(axis=2))
    alpha = np.clip((d - KEY_LO) / (KEY_HI - KEY_LO), 0, 1)
    part = (alpha > 0) & (alpha < 1)
    out = a.copy()
    # A blended outline pixel P = a C + (1 - a) M, so C = (P - (1 - a) M) / a
    out[part] = (a[part] - (1 - alpha[part, None]) * m) / alpha[part, None]
    return np.dstack([np.clip(out, 0, 255), alpha * 255]).astype(np.uint8)


# ---------------------------------------------------------------------------
# prepare
# ---------------------------------------------------------------------------

def standing_path(sprite_dir, name, d, festive):
    return sprite_dir / (f"{name}-{d}-xmas.webp" if festive else f"{name}-{d}.png")


def prepare(sprite_dir, name, festive):
    paths = [standing_path(sprite_dir, name, d, festive) for d in DIRS]
    missing = [str(p) for p in paths if not p.exists()]
    if missing:
        sys.exit("Missing standing sprites: " + ", ".join(missing))
    ims = [Image.open(p).convert("RGBA") for p in paths]
    # Why ~800 px tall: ChatGPT draws cleaner strides from a large reference
    scale = 800 / max(i.height for i in ims)
    ims = [i.resize((round(i.width * scale), round(i.height * scale)), Image.LANCZOS) for i in ims]
    cw = max(i.width for i in ims) + 60
    ch = max(i.height for i in ims)
    sheet = Image.new("RGBA", (cw * 3, ch), (255, 0, 255, 255))
    for k, im in enumerate(ims):
        sheet.alpha_composite(im, (k * cw + (cw - im.width) // 2, ch - im.height))
    out = Path(f"{name}{'-xmas' if festive else ''}-walk-input.png")
    sheet.convert("RGB").save(out)
    print(f"Wrote {out}. Upload it to ChatGPT with this prompt, then run:")
    print(f"  python3 scripts/walk-cycle.py cut <chatgpt-image.png> {name}{' --festive' if festive else ''}\n")
    print(PROMPT + (FESTIVE_PROMPT_EXTRA if festive else ""))


# ---------------------------------------------------------------------------
# cut
# ---------------------------------------------------------------------------

def runs(occupied, min_len):
    """[start, end) spans of consecutive True longer than min_len."""
    out, start = [], None
    for i, on in enumerate(list(occupied) + [False]):
        if on and start is None:
            start = i
        elif not on and start is not None:
            if i - start > min_len:
                out.append((start, i))
            start = None
    return out


def feet(alpha):
    """(top row, bottom row, x centre of the lowest quarter) of a figure's alpha."""
    rows = np.where(alpha.max(axis=1) > 128)[0]
    top, bottom = rows[0], rows[-1]
    band = alpha[bottom - (bottom - top) // 4: bottom + 1] > 128
    cols = np.where(band.any(axis=0))[0]
    return top, bottom, (cols[0] + cols[-1]) / 2


def cut(sheet_path, sprite_dir, name, festive, no_mirror):
    rgba = key(np.asarray(Image.open(sheet_path).convert("RGB")))
    rows = runs((rgba[..., 3] > 128).sum(axis=1) > 2, 40)
    if len(rows) != 3:
        sys.exit(f"Expected 3 rows of figures, found {len(rows)}: ask ChatGPT again for a clean 3 x 4 grid")
    suffix = "-xmas" if festive else ""
    for (y0, y1), d in zip(rows, DIRS):
        band = rgba[y0:y1]
        cols = runs((band[..., 3] > 128).sum(axis=0) > 2, 20)
        if len(cols) != 4:
            sys.exit(f"{d}: expected 4 figures in its row, found {len(cols)}")
        orig = np.asarray(Image.open(standing_path(sprite_dir, name, d, festive)).convert("RGBA"))
        oh, ow = orig.shape[:2]
        ot, ob, oc = feet(orig[..., 3])
        cells = [band[:, x0:x1] for x0, x1 in cols]
        fs = [feet(c[..., 3]) for c in cells]
        # Why one scale per row: the frames keep the bob ChatGPT drew between them
        s = (ob - ot + 1) / max(gb - gt + 1 for gt, gb, _ in fs)
        upper = slice(int(ot), int(ot + (ob - ot) * 0.55))  # head and torso
        om = orig[upper, :, 3] > 128

        def overlap(im):
            m = np.asarray(im)[upper, :, 3] > 128
            return (m & om).sum() / max(1, (m | om).sum())

        drawn, flipped = [], []
        for c, (gt, gb, gc) in zip(cells, fs):
            fig = Image.fromarray(c[gt:gb + 1], "RGBA")
            fig = fig.resize((max(1, round(fig.width * s)), max(1, round(fig.height * s))), Image.LANCZOS)
            y = int(ob + 1 - fig.height)
            cv = Image.new("RGBA", (ow, oh), (0, 0, 0, 0))
            cv.alpha_composite(fig, (int(round(oc - gc * s)), y))
            mv = Image.new("RGBA", (ow, oh), (0, 0, 0, 0))
            mv.alpha_composite(fig.transpose(Image.FLIP_LEFT_RIGHT), (int(round(oc - (fig.width - gc * s))), y))
            drawn.append(cv)
            flipped.append(mv)
        as_drawn = np.mean([overlap(c) for c in drawn])
        as_flipped = np.mean([overlap(c) for c in flipped])
        # Why 0.02: on a near tie (a back view is almost symmetric) keep the row as drawn
        if as_flipped > as_drawn + 0.02 and not no_mirror:
            drawn = flipped
            print(f"  {d}: drawn facing the other way, mirrored")
        for k, cv in enumerate(drawn):
            out = sprite_dir / f"{name}-{d}{suffix}-walk{k + 1}.webp"
            cv.resize((round(ow * OUT_H / oh), OUT_H), Image.LANCZOS).save(out, "WEBP", quality=90, alpha_quality=100, method=6)
        print(f"{d}: 4 frames -> {sprite_dir.relative_to(ROOT) if sprite_dir.is_relative_to(ROOT) else sprite_dir}/{name}-{d}{suffix}-walk1..4.webp")


def main():
    ap = argparse.ArgumentParser(description="Give a character sprite its four-frame walk cycle.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare", help="write the image to upload to ChatGPT, and print the prompt")
    p.add_argument("name")
    c = sub.add_parser("cut", help="cut ChatGPT's 3 x 4 sheet into the walk frames")
    c.add_argument("sheet")
    c.add_argument("name")
    c.add_argument("--no-mirror", action="store_true", help="never flip a row (an outfit with words on it)")
    t = sub.add_parser("prompt", help="print the ChatGPT prompt")
    t.add_argument("--festive", action="store_true")
    for q in (p, c):
        q.add_argument("--dir", default=str(ROOT / "public" / "sprites" / "characters"))
        q.add_argument("--festive", action="store_true", help="the Christmas copy (-xmas.webp)")
    a = ap.parse_args()
    if a.cmd == "prompt":
        print(PROMPT + (FESTIVE_PROMPT_EXTRA if a.festive else ""))
        return
    need_images()
    sprite_dir = Path(a.dir).resolve()
    if a.cmd == "prepare":
        prepare(sprite_dir, a.name, a.festive)
    else:
        cut(a.sheet, sprite_dir, a.name, a.festive, a.no_mirror)


if __name__ == "__main__":
    main()
