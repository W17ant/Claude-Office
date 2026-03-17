#!/usr/bin/env python3
"""
split-character.py — Split a 2x2 character sprite sheet into 4 directional images.

Usage:
    python3 split-character.py <input-image> <character-name> [--output-dir <dir>]

Example:
    python3 split-character.py my-character.png "Antony"
    python3 split-character.py my-character.png "Antony" --output-dir ./public/sprites/characters

The input image should be a 2x2 grid:
    ┌──────────┬──────────┐
    │front-left│front-right│
    ├──────────┼──────────┤
    │rear-left │rear-right │
    └──────────┴──────────┘

Outputs 4 files:
    {name}-1-front-left.png
    {name}-1-front-right.png
    {name}-1-rear-left.png
    {name}-1-rear-right.png
"""

import sys
import os
import argparse

def split_image_pillow(input_path, name, output_dir):
    """Split using Pillow (pip install Pillow)."""
    from PIL import Image

    img = Image.open(input_path).convert('RGBA')
    w, h = img.size
    half_w = w // 2
    half_h = h // 2

    quadrants = {
        'front-left':  img.crop((0, 0, half_w, half_h)),
        'front-right': img.crop((half_w, 0, w, half_h)),
        'rear-left':   img.crop((0, half_h, half_w, h)),
        'rear-right':  img.crop((half_w, half_h, w, h)),
    }

    for direction, quadrant in quadrants.items():
        # Auto-trim transparent edges
        bbox = quadrant.getbbox()
        if bbox:
            quadrant = quadrant.crop(bbox)

        filename = f"{name}-1-{direction}.png"
        filepath = os.path.join(output_dir, filename)
        quadrant.save(filepath, 'PNG')
        print(f"  ✓ {filepath} ({quadrant.size[0]}x{quadrant.size[1]})")


def split_image_sips(input_path, name, output_dir):
    """Split using macOS sips + ImageMagick convert (no pip needed)."""
    import subprocess
    import shutil

    # Get image dimensions
    result = subprocess.run(
        ['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', input_path],
        capture_output=True, text=True
    )
    lines = result.stdout.strip().split('\n')
    w = int([l for l in lines if 'pixelWidth' in l][0].split(':')[1].strip())
    h = int([l for l in lines if 'pixelHeight' in l][0].split(':')[1].strip())

    half_w = w // 2
    half_h = h // 2

    quadrants = {
        'front-left':  (0, 0, half_w, half_h),
        'front-right': (half_w, 0, half_w, half_h),
        'rear-left':   (0, half_h, half_w, half_h),
        'rear-right':  (half_w, half_h, half_w, half_h),
    }

    for direction, (x, y, cw, ch) in quadrants.items():
        filename = f"{name}-1-{direction}.png"
        filepath = os.path.join(output_dir, filename)

        # Copy then crop with sips
        shutil.copy2(input_path, filepath)
        subprocess.run([
            'sips', '--cropToHeightWidth', str(ch), str(cw),
            '--cropOffset', str(y), str(x),
            filepath
        ], capture_output=True)

        print(f"  ✓ {filepath}")


def main():
    parser = argparse.ArgumentParser(
        description='Split a 2x2 character sprite sheet into 4 directional images.'
    )
    parser.add_argument('input', help='Path to the sprite sheet image')
    parser.add_argument('name', help='Character name (e.g., "Antony")')
    parser.add_argument(
        '--output-dir', '-o',
        default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            'public', 'sprites', 'characters'),
        help='Output directory (default: public/sprites/characters/)'
    )

    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"Error: Input file not found: {args.input}")
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)

    print(f"\nSplitting {args.input} into 4 directions for '{args.name}':")
    print(f"Output: {args.output_dir}\n")

    # Try Pillow first, fall back to sips (macOS)
    try:
        from PIL import Image
        split_image_pillow(args.input, args.name, args.output_dir)
    except ImportError:
        print("  (Pillow not installed, using macOS sips)")
        try:
            split_image_sips(args.input, args.name, args.output_dir)
        except Exception as e:
            print(f"\nError: Could not split image. Install Pillow:")
            print(f"  pip3 install Pillow")
            sys.exit(1)

    print(f"\nDone! Now update src/config.ts:")
    print(f"  export const BOSS_CHAR = '{args.name}-1'")
    print(f"\nAnd update src/types.ts:")
    print(f"  'boss': {{ color: '#ff4444', emoji: '👑', title: '{args.name}' }},")
    print()


if __name__ == '__main__':
    main()
