/**
 * roomRules.ts - which room an agent belongs in, as pure rules over a few facts.
 *
 * The one place that says what the rooms mean. No office state, no clock and
 * no React in here: the reducer (src/officeReducer.ts, via src/roomTransfer.ts)
 * gathers the facts for one agent, asks `wantedRoom`, waits out `dwellMs` and
 * then walks the agent over.
 *
 *   office        everyone's desk; the boss and the ?sim Claude never leave it
 *   server room   MCP server workers (their home: they arrive there and leave from there)
 *   meeting room  a session's Claude and workers while it runs several workers
 *                 at once, or while it waits on you (a permission dialog, a
 *                 question)
 *   lunch room    an agent that has had nothing to do for a while; coffee and
 *                 water breaks go there too (the break itself is decided in
 *                 the reducer's break code, with `LUNCH_ROOM`)
 *
 * A room that is not open is never wanted, so with every extra room closed
 * the answer is always the agent's home and nobody moves.
 */

import type { RoomId } from './rooms'

export const OFFICE: RoomId = 'main-office'
export const MEETING_ROOM: RoomId = 'meeting-room'
export const SERVER_ROOM: RoomId = 'server-room'
export const LUNCH_ROOM: RoomId = 'lunch-room'

/**
 * A session goes to the meeting room once it runs this many workers at once.
 * Why 3: "several". One or two workers is the everyday case (an Explore and a
 * reviewer) and would empty the office on almost every turn.
 */
export const MEETING_MIN_WORKERS = 3
/**
 * ...and stays there until it is down to fewer than this many.
 * Why lower than the way in: workers of a batch finish seconds apart, and
 * with one threshold the team would walk out at 3 -> 2 and straight back at
 * 2 -> 3 when the next one spawns. The gap is what stops the ping-pong.
 */
export const MEETING_STAY_WORKERS = 2

/**
 * Nothing to do for this long: off to the lunch room.
 * Why 2 minutes: a Claude between turns dozes at its desk after 30 s and is
 * usually given the next prompt within a minute or two, and the boss hands
 * that prompt over at its desk. Leaving sooner would have it away for most
 * hand-overs; two minutes means the person has probably stepped away too.
 */
export const LUNCH_IDLE_MS = 120_000

/**
 * How long a reason must hold before the agent gets up. The walk there and
 * back is about half a minute, so anything that is over in a few seconds
 * should not start one.
 */
export const DWELL_MS: Record<RoomReason, number> = {
  // Why 10 s: most permission dialogs are answered within a few seconds;
  // only one that is really waiting on you is worth a meeting.
  'needs-you': 10_000,
  // Why 5 s: a burst of spawns settles first, and a batch of quick workers
  // that is gone again in seconds never sets off.
  team: 5_000,
  // Why 0: LUNCH_IDLE_MS already is the wait.
  idle: 0,
  // Why 3 s: back to the desk promptly when the reason is gone (a prompt
  // arrived, the dialog was answered), but not on a one-frame flicker of it.
  home: 3_000,
}

/** Why an agent wants the room it wants */
export type RoomReason = 'home' | 'needs-you' | 'team' | 'idle'

/** What the rules need to know about one agent */
export interface RoomFacts {
  /** The room its desk (or rack) is in */
  home: RoomId
  /** The room it is settled in right now */
  current: RoomId
  /** Never leaves home: the boss, the decorative ?sim Claude, an MCP server worker */
  pinned: boolean
  /** Workers its session is running right now (itself included when it is one) */
  teamSize: number
  /** Its session's Claude has a hand up that needs a person (src/mainState.ts isHardNeedsYou) */
  sessionNeedsYou: boolean
  /** How long it has been idle, null when it is not */
  idleForMs: number | null
}

export interface RoomWish {
  room: RoomId
  reason: RoomReason
}

/**
 * Whether a session with this many workers is "running several at once".
 * @param teamSize workers the session is running now
 * @param inMeeting the agent asking already sits in the meeting room
 * @returns true when the team should be (or stay) in the meeting room
 */
export function isTeam(teamSize: number, inMeeting: boolean): boolean {
  return teamSize >= (inMeeting ? MEETING_STAY_WORKERS : MEETING_MIN_WORKERS)
}

/**
 * The room an agent belongs in right now. First match wins: pinned staff stay
 * home; a session waiting on you meets; a session running several workers
 * meets; a long-idle agent goes to lunch; everyone else is at home.
 * @param f the facts about the agent
 * @param open the rooms in use (src/roomAccess.ts openRoomSet)
 * @returns the room and the reason for it
 */
export function wantedRoom(f: RoomFacts, open: ReadonlySet<RoomId>): RoomWish {
  if (f.pinned) return { room: f.home, reason: 'home' }
  if (open.has(MEETING_ROOM)) {
    if (f.sessionNeedsYou) return { room: MEETING_ROOM, reason: 'needs-you' }
    if (isTeam(f.teamSize, f.current === MEETING_ROOM)) return { room: MEETING_ROOM, reason: 'team' }
  }
  if (open.has(LUNCH_ROOM) && f.idleForMs !== null && f.idleForMs >= LUNCH_IDLE_MS) return { room: LUNCH_ROOM, reason: 'idle' }
  return { room: f.home, reason: 'home' }
}

/**
 * How long a wish must have held before the agent sets off.
 * @param reason why it wants to move
 * @returns the wait in ms
 */
export function dwellMs(reason: RoomReason): number {
  return DWELL_MS[reason]
}
