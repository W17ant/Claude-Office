# Incident mode art slots

All seven slots are drawn (generated with ChatGPT from the existing culture
art, then fitted to these canvas sizes). Replace a PNG here and the office
picks it up on the next load, no code change needed; delete one and its
fallback below comes back. The slot table lives in `src/incidentAssets.ts`;
the incident board's placement over the wall board is INCIDENT_BOARD in
`src/components/IncidentLayer.tsx` (it depends on where this PNG's writing
surface is, so re-measure it if the board art changes).

| File | Size (px) | Used for | Fallback if deleted |
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
