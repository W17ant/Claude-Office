/**
 * rooms.ts - the office's rooms: where the doors, desks, seats and walking routes are.
 *
 * Five places in a star. The corridor is the hub: the office's one door leads
 * to it and every other room has one door onto it, so any room change is
 * "own door -> corridor -> their door" (findRoomPath). People join and leave
 * the building through the corridor's front door.
 *
 *   main-office    desk work (the only room with art today)
 *   corridor       the hub; front door / lift; the manager's nameplate door is
 *                  decoration only (no room behind it, the boss sits in the office)
 *   meeting-room   a session's agents when it runs several at once or waits on you
 *   server-room    MCP server workers
 *   lunch-room     long-idle agents and coffee / water breaks
 *
 * Which room an agent belongs in is decided in src/roomRules.ts; whether a
 * room can be used at all (its art exists, or ?rooms=all) in src/roomAccess.ts;
 * the walk between rooms in src/roomTransfer.ts.
 *
 * Positions are percentages (0-100) of the room picture, which is 4800 x 3584
 * for every room. The four new rooms' layouts are PROVISIONAL: they were
 * placed by hand against the code-drawn placeholder (src/components/
 * RoomBackdrop.tsx) so the preview works, and are to be re-placed with
 * /?helper once each room's art is drawn (docs/reference.md, "Rooms").
 */

export type RoomId =
  | 'main-office'
  | 'corridor'
  | 'meeting-room'
  | 'server-room'
  | 'lunch-room'

export interface Waypoint {
  id: string
  x: number  // percentage
  y: number
  connections: string[]  // ids of connected waypoints
}

export interface FurnitureItem {
  id: string
  type: string        // e.g. 'desk-dual', 'chair-aeron', 'plant-monstera'
  sprite: string      // sprite sheet + frame reference
  x: number           // percentage position within room (0-100)
  y: number
  zIndex?: number
  state?: string      // e.g. 'empty', 'occupied', 'brewing'
  interactive?: boolean
  label?: string
}

export type SpriteFacing = 'front-left' | 'front-right' | 'rear-left' | 'rear-right'

export interface RoomConnection {
  toRoom: RoomId
  position: { x: number; y: number }  // door/exit position in current room (%)
  label?: string
  exitFacing?: SpriteFacing   // agent direction when leaving through this door
  entryFacing?: SpriteFacing  // agent direction when arriving through this door
}

export interface AgentSpot {
  id: string
  type: 'desk' | 'meeting-seat' | 'lounge' | 'standing' | 'water' | 'coffee' | 'filing' | 'printer' | 'door'
  x: number
  y: number
  facing?: 'up' | 'down' | 'left' | 'right'
  spriteFacing?: SpriteFacing  // which direction the agent faces when at this spot
  zIndex?: number  // explicit z-index override (for agents behind desks)
}

/**
 * Something the room's picture shows that is not a way into another room:
 * the corridor's front door (where people join and leave the building) and
 * the manager's nameplate door (decoration; nobody walks through it).
 */
export interface RoomLandmark {
  id: string
  kind: 'front-door' | 'decor-door'
  label: string
  x: number
  y: number
}

export interface Room {
  id: RoomId
  name: string
  description: string
  background: {
    day: string       // path to empty room background
    night: string
  }
  /** The same two pictures for the Dunder Mifflin theme (the office's own live in src/theme.ts) */
  backgroundDm?: {
    day: string
    night: string
  }
  width: number       // room dimensions in px (rendered)
  height: number
  furniture: FurnitureItem[]
  connections: RoomConnection[]
  agentSpots: AgentSpot[]       // where agents can sit/stand/work
  entryPoint: { x: number; y: number }  // where agents appear when entering
  walkableArea?: { x: number; y: number }[]  // polygon defining where agents can walk
  ambience?: string   // ambient sound loop
  waypoints?: Waypoint[]  // named walkable nodes for pathfinding
  /** Doors and the like that lead nowhere in the model (see RoomLandmark) */
  landmarks?: RoomLandmark[]
  /** true while the layout was placed without art: re-place it with /?helper when the art lands */
  provisional?: boolean
}

/** The room every other room opens onto */
export const HUB_ROOM: RoomId = 'corridor'
/** Where everyone has a desk; the room shown by default */
export const OFFICE_ROOM: RoomId = 'main-office'

// Why one door position for the three side rooms: until their art exists the
// placeholder draws each as the same plain box, and a shared door keeps the
// provisional layouts easy to check against each other.
const SIDE_DOOR = { x: 18, y: 50 }
// Why this rectangle: it is the floor the placeholder draws (back wall above
// y = 50), leaving a margin so a sprite's head and name tag stay on the picture.
const SIDE_FLOOR = [{ x: 8, y: 50 }, { x: 92, y: 50 }, { x: 92, y: 88 }, { x: 8, y: 88 }]

// ===== ROOM DEFINITIONS =====

export const ROOMS: Record<RoomId, Room> = {
  'main-office': {
    id: 'main-office',
    name: 'Main Office',
    description: 'Open plan workspace where agents code, debug, and ship',
    background: {
      day: '/rooms/office-day.png',
      night: '/rooms/office-night.png',
    },
    width: 800,
    height: 600,
    furniture: [
      // Desk cluster - back
      { id: 'desk-1a', type: 'desk-standing', sprite: 'desk-standing-left-rear', x: 42.4, y: 50.4 },
      { id: 'desk-1b', type: 'desk-standing', sprite: 'desk-standing-left-front', x: 46.7, y: 53 },
      { id: 'desk-1c', type: 'desk-standing', sprite: 'desk-standing-right-front', x: 39.9, y: 55.2 },
      // Desk cluster - front left
      { id: 'desk-2a', type: 'desk-standing', sprite: 'desk-standing-left-rear', x: 31.4, y: 64.8 },
      { id: 'desk-2b', type: 'desk-standing', sprite: 'desk-standing-left-front', x: 35.4, y: 67.5 },
      { id: 'desk-2c', type: 'desk-standing', sprite: 'desk-standing-right-front', x: 27.9, y: 70 },
      // Desk cluster - right
      { id: 'desk-3a', type: 'desk-standing', sprite: 'desk-standing-left-rear', x: 59, y: 73.7 },
      { id: 'desk-3b', type: 'desk-standing', sprite: 'desk-standing-left-front', x: 62.6, y: 76 },
      { id: 'desk-3c', type: 'desk-standing', sprite: 'desk-standing-right-front', x: 55.4, y: 78.7 },
      { id: 'desk-3d', type: 'desk-standing', sprite: 'desk-standing-right-rear', x: 66.6, y: 71.1 },
      // Coffee machine on counter
      { id: 'coffee', type: 'coffee-machine', sprite: 'coffee-off', x: 78.5, y: 50.2, interactive: true, state: 'off', label: 'Coffee Machine' },
      // Filing cabinet
      { id: 'filing-1', type: 'filing-cabinet', sprite: 'filing-closed', x: 45, y: 56.5, state: 'closed', label: 'Filing Cabinet' },
      // Plants
      { id: 'plant-1', type: 'plant-monstera', sprite: 'plant-monstera', x: 91.9, y: 64.7 },
      { id: 'plant-2', type: 'plant-snake', sprite: 'plant-snake', x: 43.2, y: 37.9 },
      { id: 'plant-3', type: 'plant-money', sprite: 'plant-money', x: 32, y: 71.2 },
      { id: 'plant-4', type: 'plant-money', sprite: 'plant-money', x: 89.2, y: 65.7 },
      { id: 'plant-5', type: 'plant-monstera', sprite: 'plant-monstera', x: 60.2, y: 80.4 },
      // Printer (swaps between working/broken on printer jam event)
      { id: 'printer-1', type: 'printer', sprite: 'printer-working', x: 85.4, y: 56.8, state: 'working', label: 'Printer' },
      // Background hotspots — baked into the room image, no sprite, just clickable zones
      { id: 'fire-extinguisher', type: 'hotspot', sprite: 'hotspot', x: 8, y: 60, interactive: true, label: 'Fire Extinguisher' },
      { id: 'water-cooler', type: 'hotspot', sprite: 'hotspot', x: 53, y: 45, interactive: true, label: 'Water Cooler' },
      { id: 'bell', type: 'hotspot', sprite: 'hotspot', x: 63, y: 39, interactive: true, label: 'Bell' },
      { id: 'kanban-board', type: 'hotspot', sprite: 'hotspot', x: 80, y: 42, interactive: true, label: 'Kanban Board' },
      { id: 'ship-it-poster', type: 'hotspot', sprite: 'hotspot', x: 8, y: 45, interactive: true, label: 'Ship It Poster' },
      { id: 'tv-monitor', type: 'hotspot', sprite: 'hotspot', x: 90, y: 42, interactive: true, label: 'Dashboard' },
    ],
    connections: [
      // The office's one door: it leads to the corridor, and through it to every other room
      { toRoom: 'corridor', position: { x: 67.5, y: 48.9 }, label: 'Corridor', exitFacing: 'rear-right', entryFacing: 'front-right' },
    ],
    agentSpots: [
      // Desk spots
      // In front of desk: rear-left/rear-right (z higher than desk)
      // Behind desk: front-left/front-right (z lower than desk)
      // Front-left cluster: desks at y ~65-70
      { id: 'spot-1', type: 'desk', x: 25.8, y: 71, facing: 'down', spriteFacing: 'rear-left', zIndex: 85 },
      { id: 'spot-2', type: 'desk', x: 37.9, y: 68.2, facing: 'down', spriteFacing: 'rear-right', zIndex: 85 },
      { id: 'spot-3', type: 'desk', x: 26.9, y: 59.2, facing: 'down', spriteFacing: 'front-left', zIndex: 40 },
      // Back cluster: desks at y ~50-55
      { id: 'spot-4', type: 'desk', x: 38.5, y: 55.2, facing: 'down', spriteFacing: 'rear-left', zIndex: 58 },
      { id: 'spot-5', type: 'desk', x: 48.9, y: 52.9, facing: 'down', spriteFacing: 'rear-right', zIndex: 70 },
      { id: 'spot-6', type: 'desk', x: 38.8, y: 43.6, facing: 'down', spriteFacing: 'front-left', zIndex: 30 },
      // Right cluster: desks at y ~72-79
      { id: 'spot-7', type: 'desk', x: 52.7, y: 78.8, facing: 'down', spriteFacing: 'rear-left', zIndex: 95 },
      { id: 'spot-8', type: 'desk', x: 65.9, y: 75.8, facing: 'down', spriteFacing: 'rear-right', zIndex: 95 },
      { id: 'spot-9', type: 'desk', x: 55.2, y: 66.8, facing: 'down', spriteFacing: 'front-left', zIndex: 55 },
      { id: 'spot-10', type: 'desk', x: 68.7, y: 66.2, facing: 'down', spriteFacing: 'front-right', zIndex: 55 },
      // Activity spots
      { id: 'spot-coffee-1', type: 'coffee', x: 73.5, y: 56.7, facing: 'down', spriteFacing: 'rear-left' },
      { id: 'spot-coffee-2', type: 'coffee', x: 76.2, y: 58.4, facing: 'down', spriteFacing: 'front-right' },
      { id: 'spot-water-1', type: 'water', x: 53.3, y: 46.6, facing: 'down', spriteFacing: 'rear-left' },
      { id: 'spot-water-2', type: 'water', x: 56, y: 47.7, facing: 'down', spriteFacing: 'front-right' },
      { id: 'spot-filing', type: 'filing', x: 47.8, y: 57.6, facing: 'down', spriteFacing: 'front-right', zIndex: 70 },
      { id: 'spot-printer', type: 'printer', x: 81, y: 63, facing: 'down', spriteFacing: 'rear-left' },
      { id: 'spot-door-2', type: 'door', x: 64, y: 46.6, facing: 'down', spriteFacing: 'rear-right' },
      { id: 'spot-door-3', type: 'door', x: 69.9, y: 50.8, facing: 'down', spriteFacing: 'front-right' },
    ],
    entryPoint: { x: 67.5, y: 48.9 },
    walkableArea: [
      { x: 28.2, y: 46 },
      { x: 33, y: 50.2 },
      { x: 20.6, y: 60.9 },
      { x: 21.8, y: 65.5 },
      { x: 32, y: 71.4 },
      { x: 41.6, y: 62.7 },
      { x: 40.8, y: 58.1 },
      { x: 45.5, y: 56.3 },
      { x: 49.3, y: 54.5 },
      { x: 51.3, y: 52.2 },
      { x: 51.9, y: 49.3 },
      { x: 51.5, y: 46.7 },
      { x: 57.9, y: 47.3 },
      { x: 64.2, y: 47.4 },
      { x: 70, y: 49.9 },
      { x: 71.2, y: 55.4 },
      { x: 78.8, y: 60.7 },
      { x: 86.7, y: 65.6 },
      { x: 82.6, y: 72.8 },
      { x: 71.5, y: 68.4 },
      { x: 59.5, y: 57.1 },
      { x: 54.7, y: 61.9 },
      { x: 51.4, y: 65.9 },
      { x: 49.8, y: 70.1 },
      { x: 50, y: 75.3 },
      { x: 54.3, y: 78.2 },
      { x: 58.1, y: 80 },
      { x: 62.5, y: 78.9 },
      { x: 64.9, y: 76 },
      { x: 68.4, y: 73.3 },
      { x: 70.4, y: 71.1 },
      { x: 71.7, y: 69.3 },
      { x: 82.7, y: 73.4 },
      { x: 54.3, y: 93.6 },
      { x: 37.6, y: 84 },
      { x: 23.5, y: 75.6 },
      { x: 12.6, y: 68.8 },
      { x: 3.9, y: 62.9 },
      { x: 33.7, y: 42.4 },
      { x: 35.5, y: 48.6 },
      { x: 33, y: 50.2 },
      { x: 28.7, y: 46.3 },
    ],
    waypoints: [
      // User-mapped routes from /?helper — spots + aisle junctions
      { id: 'W-door',      x: 67.5, y: 48.9, connections: ['W-door-2', 'W-door-3'] },
      { id: 'W-door-2',    x: 64,   y: 46.6, connections: ['W-door', 'W-water-1', 'W-new-6'] },
      { id: 'W-door-3',    x: 69.9, y: 50.8, connections: ['W-door', 'W-coffee-1', 'W-spot-10', 'W-new-7'] },
      { id: 'W-water-1',   x: 53.3, y: 46.6, connections: ['W-door-2', 'W-water-2', 'W-spot-5'] },
      { id: 'W-water-2',   x: 56,   y: 47.7, connections: ['W-water-1', 'W-door-2', 'W-new-10'] },
      { id: 'W-spot-6',    x: 38.8, y: 43.6, connections: ['W-spot-4', 'W-water-1'] },
      { id: 'W-spot-4',    x: 38.5, y: 55.2, connections: ['W-spot-6', 'W-spot-5', 'W-spot-3', 'W-filing', 'W-new-19'] },
      { id: 'W-spot-5',    x: 48.9, y: 52.9, connections: ['W-spot-4', 'W-water-1', 'W-filing', 'W-spot-9'] },
      { id: 'W-filing',    x: 47.8, y: 57.6, connections: ['W-spot-4', 'W-spot-5', 'W-spot-9', 'W-new-4'] },
      { id: 'W-spot-3',    x: 26.9, y: 59.2, connections: ['W-spot-4', 'W-spot-1'] },
      { id: 'W-spot-1',    x: 25.8, y: 71,   connections: ['W-spot-3', 'W-spot-2', 'W-new-12'] },
      { id: 'W-spot-2',    x: 37.9, y: 68.2, connections: ['W-spot-1', 'W-spot-4', 'W-spot-7', 'W-new-2'] },
      { id: 'W-spot-9',    x: 55.2, y: 66.8, connections: ['W-filing', 'W-spot-5', 'W-spot-7', 'W-spot-10'] },
      { id: 'W-spot-10',   x: 68.7, y: 66.2, connections: ['W-spot-9', 'W-spot-8', 'W-door-3', 'W-coffee-1'] },
      { id: 'W-spot-7',    x: 52.7, y: 78.8, connections: ['W-spot-9', 'W-spot-2', 'W-spot-8'] },
      { id: 'W-spot-8',    x: 65.9, y: 75.8, connections: ['W-spot-7', 'W-spot-10', 'W-new-22'] },
      { id: 'W-coffee-1',  x: 73.5, y: 56.7, connections: ['W-door-3', 'W-coffee-2', 'W-spot-10'] },
      { id: 'W-coffee-2',  x: 76.2, y: 58.4, connections: ['W-coffee-1', 'W-printer'] },
      { id: 'W-printer',   x: 81,   y: 63,   connections: ['W-coffee-2', 'W-new-23'] },
      // Aisle junctions
      { id: 'W-new-1',     x: 44.8, y: 63.1, connections: ['W-new-3'] },
      { id: 'W-new-2',     x: 57.5, y: 51.6, connections: ['W-spot-2', 'W-new-5'] },
      { id: 'W-new-3',     x: 37.5, y: 67.6, connections: ['W-new-1'] },
      { id: 'W-new-4',     x: 44.3, y: 63.3, connections: ['W-filing', 'W-new-14'] },
      { id: 'W-new-5',     x: 47.4, y: 58.3, connections: ['W-new-2'] },
      { id: 'W-new-6',     x: 57,   y: 52.2, connections: ['W-door-2', 'W-new-8'] },
      { id: 'W-new-7',     x: 63.9, y: 46.8, connections: ['W-door-3'] },
      { id: 'W-new-8',     x: 68.5, y: 49.9, connections: ['W-new-6'] },
      { id: 'W-new-10',    x: 55.6, y: 49.2, connections: ['W-water-2'] },
      { id: 'W-new-12',    x: 36.3, y: 76.8, connections: ['W-spot-1', 'W-new-13'] },
      { id: 'W-new-13',    x: 25.8, y: 72.2, connections: ['W-new-12', 'W-new-16'] },
      { id: 'W-new-14',    x: 36.9, y: 76.7, connections: ['W-new-4'] },
      { id: 'W-new-16',    x: 18.5, y: 59.5, connections: ['W-new-13', 'W-new-18'] },
      { id: 'W-new-18',    x: 29.9, y: 47.1, connections: ['W-new-16', 'W-new-20'] },
      { id: 'W-new-19',    x: 18.3, y: 57.7, connections: ['W-spot-4'] },
      { id: 'W-new-20',    x: 38.8, y: 54.2, connections: ['W-new-18'] },
      { id: 'W-new-22',    x: 76.3, y: 70.5, connections: ['W-spot-8', 'W-new-24'] },
      { id: 'W-new-23',    x: 66.8, y: 75.6, connections: ['W-printer'] },
      { id: 'W-new-24',    x: 81.3, y: 62.5, connections: ['W-new-22'] },
    ],
  },

  // PROVISIONAL (no art yet): a long hallway seen from the front. The four
  // room doors and the manager's nameplate door are in the back wall, left to
  // right; the front door / lift is in the left end wall. The office is the
  // door nearest the front door because that is the walk nearly every
  // newcomer and leaver makes.
  'corridor': {
    id: 'corridor',
    name: 'Corridor',
    description: 'The hallway every room opens onto. In by the front door, out the same way.',
    background: {
      day: '/rooms/corridor-day.png',
      night: '/rooms/corridor-night.png',
    },
    backgroundDm: {
      day: '/rooms/corridor-day-dm.png',
      night: '/rooms/corridor-night-dm.png',
    },
    width: 800,
    height: 600,
    furniture: [],
    connections: [
      { toRoom: 'main-office', position: { x: 22, y: 50 }, label: 'Office', exitFacing: 'rear-right', entryFacing: 'front-right' },
      { toRoom: 'meeting-room', position: { x: 40, y: 50 }, label: 'Meeting Room', exitFacing: 'rear-right', entryFacing: 'front-right' },
      { toRoom: 'server-room', position: { x: 70, y: 50 }, label: 'Server Room', exitFacing: 'rear-right', entryFacing: 'front-right' },
      { toRoom: 'lunch-room', position: { x: 86, y: 50 }, label: 'Lunch Room', exitFacing: 'rear-right', entryFacing: 'front-right' },
    ],
    landmarks: [
      { id: 'front-door', kind: 'front-door', label: 'Front door / lift', x: 6, y: 60 },
      { id: 'manager-door', kind: 'decor-door', label: 'Manager', x: 55, y: 50 },
    ],
    // Nobody is stationed in the corridor: it is only walked through
    agentSpots: [],
    // The front door: where newcomers appear and leavers are last seen
    entryPoint: { x: 6, y: 60 },
    walkableArea: [{ x: 3, y: 50 }, { x: 97, y: 50 }, { x: 97, y: 70 }, { x: 3, y: 70 }],
    waypoints: [
      { id: 'W-corr-front',   x: 6,  y: 60, connections: ['W-corr-office'] },
      { id: 'W-corr-office',  x: 22, y: 50, connections: ['W-corr-front', 'W-corr-meeting'] },
      { id: 'W-corr-meeting', x: 40, y: 50, connections: ['W-corr-office', 'W-corr-server'] },
      { id: 'W-corr-server',  x: 70, y: 50, connections: ['W-corr-meeting', 'W-corr-lunch'] },
      { id: 'W-corr-lunch',   x: 86, y: 50, connections: ['W-corr-server'] },
    ],
    provisional: true,
  },

  // PROVISIONAL (no art yet): one long table across the middle, four seats
  // behind it (facing the viewer) and four in front (backs to the viewer).
  // Eight seats: a session's Claude and seven workers; more stay at their desks.
  'meeting-room': {
    id: 'meeting-room',
    name: 'Meeting Room',
    description: 'Where a session gathers when it runs several agents at once, or waits on you.',
    background: {
      day: '/rooms/meeting-room-day.png',
      night: '/rooms/meeting-room-night.png',
    },
    backgroundDm: {
      day: '/rooms/meeting-room-day-dm.png',
      night: '/rooms/meeting-room-night-dm.png',
    },
    width: 800,
    height: 600,
    furniture: [],
    connections: [
      { toRoom: 'corridor', position: SIDE_DOOR, label: 'Corridor', exitFacing: 'rear-right', entryFacing: 'front-right' },
    ],
    agentSpots: [
      // Behind the table (drawn before it)
      { id: 'meet-1', type: 'meeting-seat', x: 38, y: 62, facing: 'down', spriteFacing: 'front-right', zIndex: 40 },
      { id: 'meet-2', type: 'meeting-seat', x: 50, y: 62, facing: 'down', spriteFacing: 'front-right', zIndex: 40 },
      { id: 'meet-3', type: 'meeting-seat', x: 62, y: 62, facing: 'down', spriteFacing: 'front-left', zIndex: 40 },
      { id: 'meet-4', type: 'meeting-seat', x: 74, y: 62, facing: 'down', spriteFacing: 'front-left', zIndex: 40 },
      // In front of the table
      { id: 'meet-5', type: 'meeting-seat', x: 38, y: 80, facing: 'up', spriteFacing: 'rear-right', zIndex: 90 },
      { id: 'meet-6', type: 'meeting-seat', x: 50, y: 80, facing: 'up', spriteFacing: 'rear-right', zIndex: 90 },
      { id: 'meet-7', type: 'meeting-seat', x: 62, y: 80, facing: 'up', spriteFacing: 'rear-left', zIndex: 90 },
      { id: 'meet-8', type: 'meeting-seat', x: 74, y: 80, facing: 'up', spriteFacing: 'rear-left', zIndex: 90 },
    ],
    entryPoint: SIDE_DOOR,
    walkableArea: SIDE_FLOOR,
    waypoints: [
      { id: 'W-meet-door',  x: 18, y: 50, connections: ['W-meet-back', 'W-meet-front'] },
      // The two aisles either side of the table: nobody walks across it
      { id: 'W-meet-back',  x: 28, y: 58, connections: ['W-meet-door'] },
      { id: 'W-meet-front', x: 26, y: 84, connections: ['W-meet-door'] },
    ],
    provisional: true,
  },

  // PROVISIONAL (no art yet): a row of six racks along the back wall, one
  // standing place in front of each. One MCP server worker per rack.
  'server-room': {
    id: 'server-room',
    name: 'Server Room',
    description: 'Racks, blinking lights and the MCP servers the sessions call.',
    background: {
      day: '/rooms/server-room-day.png',
      night: '/rooms/server-room-night.png',
    },
    backgroundDm: {
      day: '/rooms/server-room-day-dm.png',
      night: '/rooms/server-room-night-dm.png',
    },
    width: 800,
    height: 600,
    furniture: [],
    connections: [
      { toRoom: 'corridor', position: SIDE_DOOR, label: 'Corridor', exitFacing: 'rear-right', entryFacing: 'front-right' },
    ],
    agentSpots: [
      { id: 'srv-1', type: 'standing', x: 34, y: 60, facing: 'up', spriteFacing: 'rear-right' },
      { id: 'srv-2', type: 'standing', x: 44, y: 60, facing: 'up', spriteFacing: 'rear-right' },
      { id: 'srv-3', type: 'standing', x: 54, y: 60, facing: 'up', spriteFacing: 'rear-right' },
      { id: 'srv-4', type: 'standing', x: 64, y: 60, facing: 'up', spriteFacing: 'rear-left' },
      { id: 'srv-5', type: 'standing', x: 74, y: 60, facing: 'up', spriteFacing: 'rear-left' },
      { id: 'srv-6', type: 'standing', x: 84, y: 60, facing: 'up', spriteFacing: 'rear-left' },
    ],
    entryPoint: SIDE_DOOR,
    walkableArea: SIDE_FLOOR,
    waypoints: [
      { id: 'W-srv-door',  x: 18, y: 50, connections: ['W-srv-aisle'] },
      // The aisle in front of the racks
      { id: 'W-srv-aisle', x: 26, y: 64, connections: ['W-srv-door'] },
    ],
    provisional: true,
  },

  // PROVISIONAL (no art yet): a counter along the back wall on the right with
  // the coffee machine and the water cooler, and two tables with three seats
  // each. Today's "kitchen", renamed.
  'lunch-room': {
    id: 'lunch-room',
    name: 'Lunch Room',
    description: 'Coffee, water and somewhere to sit when there is nothing to do.',
    background: {
      day: '/rooms/lunch-room-day.png',
      night: '/rooms/lunch-room-night.png',
    },
    backgroundDm: {
      day: '/rooms/lunch-room-day-dm.png',
      night: '/rooms/lunch-room-night-dm.png',
    },
    width: 800,
    height: 600,
    furniture: [],
    connections: [
      { toRoom: 'corridor', position: SIDE_DOOR, label: 'Corridor', exitFacing: 'rear-right', entryFacing: 'front-right' },
    ],
    agentSpots: [
      // At the counter
      { id: 'lunch-coffee', type: 'coffee', x: 66, y: 56, facing: 'up', spriteFacing: 'rear-right' },
      { id: 'lunch-water', type: 'water', x: 82, y: 56, facing: 'up', spriteFacing: 'rear-left' },
      // Left table
      { id: 'lunch-1', type: 'lounge', x: 30, y: 68, facing: 'down', spriteFacing: 'front-right', zIndex: 50 },
      { id: 'lunch-2', type: 'lounge', x: 42, y: 68, facing: 'down', spriteFacing: 'front-left', zIndex: 50 },
      { id: 'lunch-3', type: 'lounge', x: 36, y: 82, facing: 'up', spriteFacing: 'rear-right', zIndex: 90 },
      // Right table
      { id: 'lunch-4', type: 'lounge', x: 60, y: 72, facing: 'down', spriteFacing: 'front-right', zIndex: 55 },
      { id: 'lunch-5', type: 'lounge', x: 72, y: 72, facing: 'down', spriteFacing: 'front-left', zIndex: 55 },
      { id: 'lunch-6', type: 'lounge', x: 66, y: 84, facing: 'up', spriteFacing: 'rear-left', zIndex: 90 },
    ],
    entryPoint: SIDE_DOOR,
    walkableArea: SIDE_FLOOR,
    waypoints: [
      { id: 'W-lunch-door',    x: 18, y: 50, connections: ['W-lunch-counter', 'W-lunch-tables'] },
      { id: 'W-lunch-counter', x: 50, y: 56, connections: ['W-lunch-door'] },
      { id: 'W-lunch-tables',  x: 22, y: 76, connections: ['W-lunch-door'] },
    ],
    provisional: true,
  },
}

/** Every room, in the order the floor plan lists them */
export const ROOM_IDS = Object.keys(ROOMS) as RoomId[]

// ===== ROOM NAVIGATION =====

/**
 * The rooms to pass through from one room to another, both ends included
 * (breadth-first over the doors, so the shortest way).
 * @param from the room to start in
 * @param to the room to reach
 * @returns the route, `[from]` when the two are the same or no door leads there
 */
export function findRoomPath(from: RoomId, to: RoomId): RoomId[] {
  if (from === to) return [from]

  const visited = new Set<RoomId>()
  const queue: { room: RoomId; path: RoomId[] }[] = [{ room: from, path: [from] }]
  visited.add(from)

  while (queue.length > 0) {
    const { room, path } = queue.shift()!
    const connections = ROOMS[room].connections

    for (const conn of connections) {
      if (conn.toRoom === to) return [...path, to]
      if (!visited.has(conn.toRoom)) {
        visited.add(conn.toRoom)
        queue.push({ room: conn.toRoom, path: [...path, conn.toRoom] })
      }
    }
  }

  return [from] // no path found, stay put
}

/**
 * The rooms a room's doors lead to.
 * @param roomId the room to stand in
 * @returns the rooms next door
 */
export function getConnectedRooms(roomId: RoomId): RoomId[] {
  return ROOMS[roomId].connections.map(c => c.toRoom)
}

/**
 * Where in `roomId` the door to `toRoom` is.
 * @param roomId the room to stand in
 * @param toRoom the room behind the door
 * @returns the door's position, or null when no door of this room leads there
 */
export function doorTo(roomId: RoomId, toRoom: RoomId): { x: number; y: number } | null {
  const conn = ROOMS[roomId].connections.find(c => c.toRoom === toRoom)
  return conn ? { x: conn.position.x, y: conn.position.y } : null
}

/**
 * A free agent spot in a room, in the order the room lists them.
 * @param roomId the room to look in
 * @param occupiedSpotIds spots somebody already holds
 * @param type only spots of this kind (any kind when omitted)
 * @returns the first free spot, or null when the room is full
 */
export function getFreeSpot(
  roomId: RoomId,
  occupiedSpotIds: Set<string>,
  type?: AgentSpot['type'],
): AgentSpot | null {
  const room = ROOMS[roomId]
  const spots = type
    ? room.agentSpots.filter(s => s.type === type)
    : room.agentSpots

  for (const spot of spots) {
    if (!occupiedSpotIds.has(spot.id)) return spot
  }
  return null
}

/**
 * Look a spot up by id in any room. Spot ids are unique across the building
 * (tests/rooms.test.ts), so the id alone says which room it is in.
 * @param spotId the spot's id
 * @returns the spot and its room, or null for an unknown id
 */
export function findSpot(spotId: string | undefined): { room: RoomId; spot: AgentSpot } | null {
  if (!spotId) return null
  for (const id of ROOM_IDS) {
    const spot = ROOMS[id].agentSpots.find(s => s.id === spotId)
    if (spot) return { room: id, spot }
  }
  return null
}
