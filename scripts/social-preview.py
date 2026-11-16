"""social-preview.py — build the repo's 1280x640 social preview from the day-mode screenshot.

GitHub shows this image when the repo link is shared (Slack, X, Discord). It
has no API for it: upload docs/images/social-preview.png in Settings > General
> Social preview.

Usage: python3 scripts/social-preview.py [--out PATH]
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'docs', 'images', 'Day-Mode.png')
DEFAULT_OUT = os.path.join(ROOT, 'docs', 'images', 'social-preview.png')

# Why 1280x640: GitHub's recommended social preview size (2:1, at least 640x320)
WIDTH, HEIGHT = 1280, 640
# Why 470: the left panel holds the title at 76px; the screenshot gets the rest
PANEL_W = 470
BG = (24, 22, 36)
INK = (245, 240, 255)
MUTED = (170, 162, 196)
ACCENT = (217, 119, 87)

# Why a list: system fonts differ by machine; the first that loads wins
BOLD_FONTS = ['/System/Library/Fonts/Avenir Next.ttc', '/System/Library/Fonts/HelveticaNeue.ttc',
              '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']
MONO_FONTS = ['/System/Library/Fonts/Menlo.ttc', '/System/Library/Fonts/SFNSMono.ttf',
              '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf']


def font(candidates, size, index=0):
    """First loadable font from candidates at size; PIL's default (scaled) as the last resort."""
    for path in candidates:
        try:
            return ImageFont.truetype(path, size, index=index)
        except OSError:
            continue
    return ImageFont.load_default(size)


def wrap(draw, text, fnt, max_w):
    """Split text into lines no wider than max_w pixels."""
    lines, line = [], ''
    for word in text.split():
        trial = f'{line} {word}'.strip()
        if draw.textlength(trial, font=fnt) <= max_w:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + [line]


def build(out):
    """Compose the preview and write it to out."""
    shot = Image.open(SOURCE).convert('RGB')
    area_w = WIDTH - PANEL_W
    # Why cover-fit with NEAREST: fills the right side edge to edge and keeps pixel art crisp
    scale = max(area_w / shot.width, HEIGHT / shot.height)
    shot = shot.resize((round(shot.width * scale), round(shot.height * scale)), Image.NEAREST)
    left = (shot.width - area_w) // 2
    top = (shot.height - HEIGHT) // 2
    shot = shot.crop((left, top, left + area_w, top + HEIGHT))

    img = Image.new('RGB', (WIDTH, HEIGHT), BG)
    img.paste(shot, (PANEL_W, 0))
    draw = ImageDraw.Draw(img)
    draw.rectangle((PANEL_W - 6, 0, PANEL_W - 1, HEIGHT), fill=ACCENT)

    x, max_w = 48, PANEL_W - 96
    # Why index 2 on Avenir Next.ttc: its Bold face; other files ignore a bad index via the fallback
    title = font(BOLD_FONTS, 76, index=2)
    body = font(BOLD_FONTS, 30, index=0)
    mono = font(MONO_FONTS, 22)

    y = 150
    for line in ['Claude', 'Office']:
        draw.text((x, y), line, font=title, fill=INK)
        y += 84
    y += 24
    for line in wrap(draw, 'Watch your AI agents work in a pixel-art office', body, max_w):
        draw.text((x, y), line, font=body, fill=MUTED)
        y += 40
    y += 36
    cmd = 'npx @w17ant/agent-office'
    pad = 12
    w = draw.textlength(cmd, font=mono)
    draw.rounded_rectangle((x - pad, y - pad, x + w + pad, y + 26 + pad), radius=8, fill=(40, 36, 58))
    draw.text((x, y), cmd, font=mono, fill=ACCENT)

    img.save(out, optimize=True)
    return out


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--out', default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    print(build(args.out))


if __name__ == '__main__':
    main(sys.argv[1:])
