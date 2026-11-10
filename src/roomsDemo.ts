/**
 * roomsDemo.ts - the extra events `?sim&rooms=all` plays so every room has somebody to show.
 *
 * ?sim's own staff have no session and call no MCP server, so on their own
 * they would only ever use the lunch room (coffee and water breaks). This
 * adds a short loop of ordinary office events, the same ones a live server
 * sends: two MCP servers taking calls (server room) and one session running
 * three workers at once (meeting room). Nothing here is special-cased in the
 * reducer; it is a script of events and a timer.
 */

import type { OfficeEvent } from './types'

/** One scripted event: `at` ms into the loop */
export interface DemoStep {
  at: number
  event: OfficeEvent
}

/** The session the demo's team works for (any id will do; no Claude is seated for it) */
export const DEMO_SESSION = 'rooms-demo'

/**
 * How long one pass of the script lasts before it starts over.
 * Why 120 s: the last worker leaves at 90 s, the MCP workers stand down 30 s
 * after their last call (MCP_LINGER_MS, by 75 s) and a walk out takes up to
 * 20 s (TRANSFER_MAX_MS), so by 120 s everybody the pass brought in is gone
 * and the next pass's ids are free again.
 */
export const DEMO_LOOP_MS = 120_000

const worker = (n: number, role: string, name: string, task: string): OfficeEvent => ({
  type: 'agent_spawned',
  sessionId: DEMO_SESSION,
  agent: { id: `rooms-demo-${n}`, name, role, task },
})

/**
 * The loop, in order. Times are chosen against the room rules
 * (src/roomRules.ts): the three workers spawn within 4 s, so the team rule
 * holds for its 5 s dwell and they walk to the meeting room together; two
 * finish at 55 s and 60 s, which takes the team under MEETING_STAY_WORKERS,
 * so the third walks back to its desk and finishes there (at 90 s: the
 * walk from the meeting room to the office, at the far end of the corridor,
 * takes it until about 77 s).
 */
export const ROOMS_DEMO_SCRIPT: readonly DemoStep[] = [
  { at: 4_000, event: { type: 'mcp_call', server: 'github', tool: 'search_code' } },
  { at: 10_000, event: worker(1, 'architect-reviewer', 'Architect', 'Planning the rooms refactor') },
  { at: 12_000, event: worker(2, 'test-engineer', 'Tester', 'Writing the transfer tests') },
  { at: 14_000, event: worker(3, 'typescript-pro', 'TS Pro', 'Typing the room rules') },
  { at: 16_000, event: { type: 'mcp_call', server: 'supabase', tool: 'execute_sql' } },
  { at: 30_000, event: { type: 'mcp_done', server: 'github' } },
  { at: 45_000, event: { type: 'mcp_done', server: 'supabase' } },
  { at: 55_000, event: { type: 'agent_completed', agentId: 'rooms-demo-1', result: 'Plan agreed' } },
  { at: 60_000, event: { type: 'agent_completed', agentId: 'rooms-demo-2', result: 'Tests written' } },
  { at: 90_000, event: { type: 'agent_completed', agentId: 'rooms-demo-3', result: 'Rules typed' } },
]

/**
 * Play the script on a loop.
 * @param dispatch where the events go (App's handleEvent)
 * @param script the steps to play (the default is ROOMS_DEMO_SCRIPT)
 * @param loopMs the length of one pass
 * @returns a function that stops the loop and clears its timers
 */
export function startRoomsDemo(
  dispatch: (event: OfficeEvent) => void,
  script: readonly DemoStep[] = ROOMS_DEMO_SCRIPT,
  loopMs: number = DEMO_LOOP_MS,
): () => void {
  let timers: ReturnType<typeof setTimeout>[] = []
  const pass = () => {
    timers = script.map(step => setTimeout(() => dispatch(step.event), step.at))
  }
  pass()
  const loop = setInterval(pass, loopMs)
  return () => {
    clearInterval(loop)
    timers.forEach(t => clearTimeout(t))
  }
}
