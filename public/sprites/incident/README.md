# Incident mode art slots

Incident mode ("Prod Is Down") ships with existing art. Drop the real PNGs
here and the office picks them up on the next load, no code change needed.
The slot table lives in `src/incidentAssets.ts`; this is the file list.

| File | Size (px) | Used for | Until it exists |
|---|---|---|---|
| `beacon-0.png` | 200x200 | rotating beacon, frame A (lens dark), above the door | `effects/fire.png` |
| `beacon-1.png` | 200x200 | beacon frame B (lens lit) | `effects/fire.png` |
| `status-screen.png` | ~852x991 | wall TV status page reading as ROLLBACK | `culture/deploying-screen.png` |
| `incident-board.png` | 606x686 | incident timeline over the kanban board | hidden |
| `pizza-tower-0.png` | 300x260 | 1 pizza box on the coffee counter (0-10 min) | hidden |
| `pizza-tower-1.png` | 300x330 | 3 boxes (10-30 min) | hidden |
| `pizza-tower-2.png` | 300x400 | 6 boxes, leaning (30 min+) | hidden |

Transparent PNG, same palette and outline style as `public/sprites/office/props/`.
Per-role incident props (pager, megaphone, canary cage, ...) are a later
follow-up and need a `props/` folder plus a role map in `src/incidentAssets.ts`.
