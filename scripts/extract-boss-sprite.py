#!/usr/bin/env python3
"""
Extract 4 directional sprites from a ChatGPT-generated sprite sheet.

Usage:
  1. Use ChatGPT (with DALL-E) to generate a character sprite sheet
     based on the Helper.png template in public/sprites/characters/
  2. Save the output as a single PNG
  3. Run: python3 scripts/extract-boss-sprite.py <input.png> <sprite-name>

This will create 4 files in public/sprites/characters/:
  <sprite-name>-front-left.png
  <sprite-name>-front-right.png  (used as rear-left in Helper layout)
  <sprite-name>-rear-left.png
  <sprite-name>-rear-right.png

The layout expected matches Helper.png:
  [Front-Left] [Rear-Right] [Front-Right] [Rear-Left]
  (4 poses in a single row)
"""

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Error: Pillow is required. Install with: pip3 install Pillow")
    sys.exit(1)

def extract_sprites(input_path: str, sprite_name: str):
    img = Image.open(input_path).convert("RGBA")
    w, h = img.size

    # Detect the sprite region (exclude labels at bottom)
    # Crop to top ~80% to remove text labels
    crop_h = int(h * 0.82)
    img = img.crop((0, 0, w, crop_h))
    w, h = img.size

    # Split into 4 equal columns
    col_w = w // 4
    positions = {
        "front-left":  (0, 0, col_w, h),
        "rear-right":  (col_w, 0, col_w * 2, h),  # Helper layout
        "front-right": (col_w * 2, 0, col_w * 3, h),
        "rear-left":   (col_w * 3, 0, w, h),
    }

    out_dir = Path(__file__).parent.parent / "public" / "sprites" / "characters"
    out_dir.mkdir(parents=True, exist_ok=True)

    for direction, box in positions.items():
        sprite = img.crop(box)

        # Auto-trim transparent edges
        bbox = sprite.getbbox()
        if bbox:
            sprite = sprite.crop(bbox)

        out_path = out_dir / f"{sprite_name}-{direction}.png"
        sprite.save(out_path, "PNG")
        print(f"  Saved: {out_path.name} ({sprite.size[0]}x{sprite.size[1]})")

    print(f"\nDone! Update office.config.json to set boss.sprite to \"{sprite_name}\"")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 extract-boss-sprite.py <input.png> <sprite-name>")
        print("Example: python3 extract-boss-sprite.py my-character.png MyChar-1")
        sys.exit(1)

    extract_sprites(sys.argv[1], sys.argv[2])
