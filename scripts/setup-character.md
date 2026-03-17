# Create Your Character

## Step 1: Generate Your Pixel Art Character

Use ChatGPT (GPT-4 with image generation) to create your character sprite sheet.

Upload the reference image `public/sprites/characters/TEMPLATE.png` along with a photo of yourself, and use this prompt:

```
Using the attached reference image as a style guide, create an isometric pixel art
character sprite sheet of me in the same art style. The sheet should have 4 views
arranged in a 2x2 grid:

Top-left: FRONT-LEFT (facing camera, angled left)
Top-right: FRONT-RIGHT (facing camera, angled right)
Bottom-left: REAR-LEFT (back turned, angled left)
Bottom-right: REAR-RIGHT (back turned, angled right)

Keep the same proportions, art style, and level of detail as the reference.
The character should be on a transparent background.
Include my actual appearance - hair, clothing style, etc.
```

## Step 2: Save the Generated Image

Save the sprite sheet as a single image (e.g., `my-character.png`).

## Step 3: Split Into 4 Direction Images

Run the Python script to automatically split the sheet into 4 separate images:

```bash
python3 scripts/split-character.py my-character.png "YourName"
```

This creates:
- `public/sprites/characters/YourName-1-front-left.png`
- `public/sprites/characters/YourName-1-front-right.png`
- `public/sprites/characters/YourName-1-rear-left.png`
- `public/sprites/characters/YourName-1-rear-right.png`

## Step 4: Configure Your Name

Edit `src/config.ts` and update:

```typescript
export const BOSS_CHAR = 'YourName-1'
```

Edit `src/types.ts` and update:

```typescript
'boss': { color: '#ff4444', emoji: '👑', title: 'YourName' },
```

## Step 5: Restart the Office

Restart the dev server and your character will appear!

## Manual Alternative

If you prefer to create the 4 images manually (e.g., in Photoshop or Aseprite),
save them directly to `public/sprites/characters/` with the naming convention:

```
YourName-1-front-left.png
YourName-1-front-right.png
YourName-1-rear-left.png
YourName-1-rear-right.png
```

Each image should be roughly 300-400px wide and 800-900px tall, with a transparent background.
