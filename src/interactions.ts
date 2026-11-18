/**
 * interactions.ts — Boss interaction definitions for clickable furniture
 *
 * Each interaction defines what happens when the boss clicks a furniture item:
 * - walkTo: position to walk to (near the item)
 * - effect: sprite to show above boss on arrival
 * - duration: how long the effect lasts (ms)
 * - chatMessage: what to post in office chat
 * - furnitureState: optional state change for the furniture item
 * - cooldown: minimum ms between interactions with this item
 */

import { boardChatLines, getShownBoard, type TaskBoardInfo } from './taskBoard'
import { list } from './i18n'

export interface Interaction {
  walkTo: { x: number; y: number }
  effect: string
  duration: number
  chatMessage: string | string[]
  furnitureState?: { id: string; state: string; revertAfter?: number }
  cooldown: number
  /** Why only 'bell': the one item the owner clicks to make a sound (src/sounds.ts) */
  sound?: 'bell'
}

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * What clicking a piece of furniture does. The kanban board (and the
 * whiteboard) reads out the task board on the wall when a session has one
 * (src/taskBoard.ts: "3 to do, 1 in progress: Fix the parser") and keeps its
 * flavour lines when none has; `board` is the shown board, passed in by tests.
 */
export function getInteraction(furnitureId: string, board: TaskBoardInfo | null = getShownBoard()): Interaction | null {
  switch (furnitureId) {
    // Plants — water them
    case 'plant-1':
      return { walkTo: { x: 90, y: 65 }, effect: '/sprites/effects/watering-can.png', duration: 3000, chatMessage: list('chatter.interactions.plant1'), cooldown: 30000 }
    case 'plant-2':
      return { walkTo: { x: 41, y: 40 }, effect: '/sprites/effects/watering-can.png', duration: 3000, chatMessage: list('chatter.interactions.plant2'), cooldown: 30000 }
    case 'plant-3':
      return { walkTo: { x: 30, y: 72 }, effect: '/sprites/effects/watering-can.png', duration: 3000, chatMessage: list('chatter.interactions.plant3'), cooldown: 30000 }
    case 'plant-4':
      return { walkTo: { x: 87, y: 66 }, effect: '/sprites/effects/watering-can.png', duration: 3000, chatMessage: list('chatter.interactions.plant4'), cooldown: 30000 }
    case 'plant-5':
      return { walkTo: { x: 58, y: 81 }, effect: '/sprites/effects/watering-can.png', duration: 3000, chatMessage: list('chatter.interactions.plant5'), cooldown: 30000 }

    // Coffee machine
    case 'coffee':
      return {
        walkTo: { x: 76, y: 56 },
        effect: '/sprites/effects/need-coffee.png',
        duration: 4000,
        chatMessage: list('chatter.interactions.coffee'),
        furnitureState: { id: 'coffee', state: 'on', revertAfter: 10000 },
        cooldown: 15000,
      }

    // Filing cabinet
    case 'filing-1':
      return {
        walkTo: { x: 47, y: 58 },
        effect: '/sprites/effects/post-it.png',
        duration: 3000,
        chatMessage: list('chatter.interactions.filing'),
        furnitureState: { id: 'filing-1', state: 'open', revertAfter: 8000 },
        cooldown: 10000,
      }

    // Printer
    case 'printer-1':
      return {
        walkTo: { x: 83, y: 63 },
        effect: '/sprites/effects/post-it.png',
        duration: 3000,
        chatMessage: list('chatter.interactions.printer'),
        cooldown: 15000,
      }

    // Whiteboard / kanban board — use the board area
    case 'whiteboard':
      return {
        walkTo: { x: 88, y: 56 },
        effect: '/sprites/effects/post-it.png',
        duration: 4000,
        chatMessage: board ? boardChatLines(board) : list('chatter.interactions.whiteboard'),
        cooldown: 20000,
      }

    // Background hotspots
    case 'fire-extinguisher':
      return { walkTo: { x: 16, y: 66 }, effect: '/sprites/effects/fire.png', duration: 3000, chatMessage: list('chatter.interactions.fireExtinguisher'), cooldown: 30000 }

    case 'water-cooler':
      return { walkTo: { x: 53, y: 47 }, effect: '/sprites/effects/glass-water.png', duration: 3000, chatMessage: list('chatter.interactions.waterCooler'), cooldown: 10000 }

    case 'bell':
      return { walkTo: { x: 63, y: 46 }, effect: '/sprites/effects/star.png', duration: 2000, chatMessage: list('chatter.interactions.bell'), cooldown: 20000, sound: 'bell' }

    case 'kanban-board':
      return {
        walkTo: { x: 78, y: 48 }, effect: '/sprites/effects/post-it.png', duration: 4000, cooldown: 15000,
        chatMessage: board ? boardChatLines(board) : list('chatter.interactions.kanban'),
      }

    case 'ship-it-poster':
      return { walkTo: { x: 16, y: 55 }, effect: '/sprites/effects/rocket.png', duration: 3000, chatMessage: list('chatter.interactions.shipItPoster'), cooldown: 30000 }

    case 'tv-monitor':
      return { walkTo: { x: 85, y: 50 }, effect: '/sprites/effects/typing.png', duration: 3000, chatMessage: list('chatter.interactions.tvMonitor'), cooldown: 15000 }

    default:
      return null
  }
}
