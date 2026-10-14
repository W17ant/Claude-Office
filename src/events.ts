// Random office events that trigger periodically

export interface RandomOfficeEvent {
  id: string
  name: string
  slackAnnouncement: string
  duration: number // ms
  type: 'all-move' | 'single-agent' | 'visual-only' | 'slack-only'
  targetPosition?: { x: number; y: number }
  agentMessages?: string[]
  managerMessage?: string
  sound?: 'alarm' | 'celebration' | 'doorOpen' | 'error' | 'powerDown' | 'notification' | 'coffee'
}

export const RANDOM_EVENTS: RandomOfficeEvent[] = [
  {
    id: 'fire-drill',
    name: 'Fire Drill',
    slackAnnouncement: '🚨 FIRE DRILL! Everyone to the exit!',
    duration: 6000,
    type: 'all-move',
    targetPosition: { x: 114, y: 105 },
    managerMessage: 'Fire drill! Move it!',
    agentMessages: ['not again...', 'I was in the zone!', 'my coffee!', 'save the codebase!'],
    sound: 'alarm',
  },
  {
    id: 'pizza',
    name: 'Pizza Delivery',
    slackAnnouncement: '🍕 Pizza has arrived! Free lunch!',
    duration: 5000,
    type: 'all-move',
    targetPosition: { x: 114, y: 105 },
    managerMessage: 'Pizza in the lobby!',
    agentMessages: ['PIZZA!', 'finally some good news', 'pineapple?!', 'dibs on pepperoni'],
    sound: 'celebration',
  },
  {
    id: 'standup',
    name: 'Daily Standup',
    slackAnnouncement: '📢 @here Daily standup starting now',
    duration: 7000,
    type: 'all-move',
    targetPosition: { x: 411, y: 417 },
    managerMessage: 'Standup! What did you ship?',
    agentMessages: ['worked on the thing', 'still debugging', 'blocked by review', 'deployed to staging', 'fixed 3 bugs, created 5'],
    sound: 'notification',
  },
  {
    id: 'deploy',
    name: 'Production Deploy',
    slackAnnouncement: '🚀 DEPLOYING TO PRODUCTION...',
    duration: 5000,
    type: 'slack-only',
    managerMessage: 'Hold your breath...',
    agentMessages: ['oh no', 'please dont break', 'I forgot to run tests', 'YOLO', 'checking rollback plan'],
    sound: 'notification',
  },
  {
    id: 'deploy-success',
    name: 'Deploy Success',
    slackAnnouncement: '✅ Deploy successful! All systems green 🎉',
    duration: 3000,
    type: 'slack-only',
    managerMessage: 'We did it!',
    agentMessages: ['lets go!', 'ship it!', 'nice work team', 'time for beer'],
    sound: 'celebration',
  },
  {
    id: 'deploy-fail',
    name: 'Deploy Failed',
    slackAnnouncement: '💥 DEPLOY FAILED - ROLLING BACK',
    duration: 4000,
    type: 'slack-only',
    managerMessage: 'WHO PUSHED THAT?!',
    agentMessages: ['wasnt me', 'oh no oh no oh no', 'checking logs', 'its always DNS', 'reverting...'],
    sound: 'error',
  },
  {
    id: 'power-flicker',
    name: 'Power Flicker',
    slackAnnouncement: '⚡ Power flickered - save your work!',
    duration: 3000,
    type: 'visual-only',
    agentMessages: ['did the lights just...', 'CTRL+S CTRL+S', 'my unsaved changes!', 'git commit NOW'],
    sound: 'powerDown',
  },
  {
    id: 'birthday',
    name: 'Birthday',
    slackAnnouncement: '🎂 Happy Birthday! Cake in the break room!',
    duration: 4000,
    type: 'all-move',
    targetPosition: { x: 287, y: 129 },
    managerMessage: 'Happy birthday!',
    agentMessages: ['cake!', 'happy birthday!', '🎉🎉🎉', 'is it gluten free?', 'make a wish'],
    sound: 'celebration',
  },
  {
    id: 'who-broke-build',
    name: 'Build Broken',
    slackAnnouncement: '🔴 CI/CD pipeline is RED. Who broke the build?',
    duration: 5000,
    type: 'slack-only',
    managerMessage: 'Nobody leaves until this is fixed.',
    agentMessages: ['checking git blame...', 'not me', 'was it the merge?', 'flaky test maybe?', 'I blame the intern'],
    sound: 'error',
  },
  {
    id: 'friday',
    name: 'Friday Vibes',
    slackAnnouncement: '🎉 It\'s Friday! Almost there team!',
    duration: 3000,
    type: 'slack-only',
    managerMessage: 'No deploys on Friday.',
    agentMessages: ['TGIF', 'pub?', 'one more PR...', 'leaving at 5 sharp', 'weekend!'],
    sound: 'celebration',
  },
  {
    id: 'printer-jam',
    name: 'Printer Jam',
    slackAnnouncement: '🖨️ The printer is jammed again',
    duration: 4000,
    type: 'single-agent',
    targetPosition: { x: 424, y: 132 },
    agentMessages: ['why do we still have a printer', 'PC LOAD LETTER?!', 'who even prints things', 'its 2026...'],
    sound: 'error',
  },
  {
    id: 'slack-down',
    name: 'Slack is Down',
    slackAnnouncement: '💀 Slack is down... wait how are we posting this',
    duration: 3000,
    type: 'slack-only',
    agentMessages: ['the irony', 'time to use email', 'carrier pigeon time', 'actually kind of peaceful'],
    sound: 'notification',
  },
]

// Office drama conversations
export const DRAMA_CONVERSATIONS = [
  {
    trigger: 'coffee-meet',
    messages: [
      { sender: 0, text: 'have you seen the new PR?' },
      { sender: 1, text: 'the 2000 line one? yeah...' },
      { sender: 0, text: 'no tests either' },
      { sender: 1, text: '💀' },
    ],
  },
  {
    trigger: 'who-pushed',
    messages: [
      { sender: 0, text: 'who pushed directly to main?' },
      { sender: 1, text: 'wasnt me' },
      { sender: 0, text: 'git blame says otherwise' },
      { sender: 1, text: '...' },
    ],
  },
  {
    trigger: 'tabs-vs-spaces',
    messages: [
      { sender: 0, text: 'tabs or spaces?' },
      { sender: 1, text: 'spaces obviously' },
      { sender: 0, text: 'blocked and reported' },
    ],
  },
  {
    trigger: 'meeting',
    messages: [
      { sender: 0, text: 'this meeting could have been a slack message' },
      { sender: 1, text: 'this slack message could have been silence' },
    ],
  },
  {
    trigger: 'framework',
    messages: [
      { sender: 0, text: 'we should rewrite in Rust' },
      { sender: 1, text: 'you say that every week' },
      { sender: 0, text: 'and Im right every week' },
    ],
  },
  {
    trigger: 'legacy',
    messages: [
      { sender: 0, text: 'found a TODO from 2019' },
      { sender: 1, text: 'what does it say' },
      { sender: 0, text: '"fix this later"' },
      { sender: 1, text: 'later is now' },
      { sender: 0, text: 'no. later is later.' },
    ],
  },
  {
    trigger: 'ai',
    messages: [
      { sender: 0, text: 'the AI wrote better code than me today' },
      { sender: 1, text: 'low bar tbf' },
      { sender: 0, text: 'rude but fair' },
    ],
  },
  {
    trigger: 'standup-excuse',
    messages: [
      { sender: 0, text: 'what did you do yesterday?' },
      { sender: 1, text: 'investigated a complex issue' },
      { sender: 0, text: 'you mean you googled for 6 hours' },
      { sender: 1, text: 'I prefer "research"' },
    ],
  },
]

// Slack reactions that randomly appear on messages
export const SLACK_REACTIONS = ['👍', '🔥', '💀', '😂', '🚀', '❤️', '👀', '💯', '🎉', '😅', '🤔', '⚡']

// Dunder Mifflin themed events — used when Office theme is active
export const OFFICE_EVENTS: RandomOfficeEvent[] = [
  {
    id: 'fire-alarm-stress-relief',
    name: 'FIRE! FIRE! FIRE!',
    slackAnnouncement: '🔥 FIRE! FIRE! FIRE! (Dwight is teaching fire safety)',
    duration: 6000,
    type: 'all-move',
    targetPosition: { x: 114, y: 105 },
    managerMessage: 'The fire is shooting at us!',
    agentMessages: ['FIRE!', 'oh my god oh my god', 'save Bandit!', 'I declare BANKRUPTCY!', 'get the defibrillator!'],
    sound: 'alarm',
  },
  {
    id: 'cpr-training',
    name: "Stayin' Alive",
    slackAnnouncement: '🫀 CPR training — stay to the beat of Stayin\' Alive',
    duration: 5000,
    type: 'slack-only',
    managerMessage: 'ah ah ah ah, stayin\' alive, stayin\' alive',
    agentMessages: ['is he... dead?', 'Dwight is cutting the face off', 'I learned this from ER', 'ah ah ah ah'],
    sound: 'notification',
  },
  {
    id: 'golden-ticket',
    name: 'Golden Ticket',
    slackAnnouncement: '🎫 Five Golden Tickets hidden in reams of paper — 10% off!',
    duration: 4000,
    type: 'slack-only',
    managerMessage: 'It was my idea. It was all me.',
    agentMessages: ['I blame Kevin', 'Willy Wonka time', 'that was all Michael', 'who approved this'],
    sound: 'celebration',
  },
  {
    id: 'jim-prank',
    name: 'Jim Pranks Dwight',
    slackAnnouncement: '🥤 Someone put Dwight\'s stapler in jello again',
    duration: 3500,
    type: 'slack-only',
    managerMessage: 'JIM!',
    agentMessages: ['not again', 'it\'s always Jim', 'identity theft is not a joke', 'Pam, help'],
    sound: 'notification',
  },
  {
    id: 'parkour',
    name: 'Parkour!',
    slackAnnouncement: '🏃 PARKOUR! PARKOUR! PARKOUR!',
    duration: 4000,
    type: 'visual-only',
    managerMessage: 'PARKOUR!',
    agentMessages: ['parkour!', 'PAR-KOUR', 'Michael no', 'this is going to end badly'],
    sound: 'celebration',
  },
  {
    id: 'schrute-bucks',
    name: 'Schrute Bucks',
    slackAnnouncement: '💵 Dwight is issuing Schrute Bucks. 1/1000th of a cent.',
    duration: 3000,
    type: 'slack-only',
    agentMessages: ['what\'s the conversion rate?', 'do I look like I need extra incentive?', 'I\'ll take Stanley nickels instead', 'where\'s my raise?'],
    sound: 'notification',
  },
  {
    id: 'kevins-chili',
    name: "Kevin's Chili",
    slackAnnouncement: '🫘 Kevin dropped the chili. Again.',
    duration: 4000,
    type: 'slack-only',
    managerMessage: 'the only thing left to do is to scoop it up...',
    agentMessages: ['NOOO', 'it took him all morning', 'carpet is ruined', 'I told him to use two pans'],
    sound: 'error',
  },
  {
    id: 'printer-jam-dm',
    name: 'Sabre Printer Jam',
    slackAnnouncement: '🖨️ The printer is on fire again. Literal fire.',
    duration: 4000,
    type: 'single-agent',
    targetPosition: { x: 424, y: 132 },
    agentMessages: ['Sabre printers strike again', 'I TOLD them', 'time to call Nellie', 'warranty expired'],
    sound: 'error',
  },
  {
    id: 'dundies',
    name: 'The Dundies',
    slackAnnouncement: '🏆 The Dundies are tonight!',
    duration: 4000,
    type: 'slack-only',
    managerMessage: 'You\'re gonna laugh, you\'re gonna cry...',
    agentMessages: ['Bushiest Beaver award time', 'Please no again', 'dibs on Best Dad', 'I\'m taking Pam to Chili\'s'],
    sound: 'celebration',
  },
  {
    id: 'pretzel-day',
    name: 'Pretzel Day',
    slackAnnouncement: '🥨 IT\'S PRETZEL DAY',
    duration: 5000,
    type: 'all-move',
    targetPosition: { x: 287, y: 129 },
    managerMessage: 'You don\'t understand. It\'s pretzel day.',
    agentMessages: ['best day of the year', 'worth every calorie', 'Stanley\'s been waiting all year', 'all the toppings'],
    sound: 'celebration',
  },
  {
    id: 'bears-beets',
    name: 'Bears. Beets. Battlestar Galactica.',
    slackAnnouncement: '📋 Question: what kind of bear is best?',
    duration: 3000,
    type: 'slack-only',
    agentMessages: ['false. black bear.', 'Bears, beets, Battlestar Galactica', 'identity theft is not a joke, Jim', 'fact: bears eat beets'],
    sound: 'notification',
  },
]

// Incident-mode events — SAME ids as RANDOM_EVENTS so EVENT_TARGETS in App.tsx
// resolves without new entries; only the copy and sounds change. deploy-fail /
// who-broke-build start a mini-incident and deploy-success ends one (incident.ts).
export const INCIDENT_EVENTS: RandomOfficeEvent[] = [
  {
    id: 'fire-drill',
    name: 'War Room',
    slackAnnouncement: '🚨 everyone to the door — bridge call starting',
    duration: 6000,
    type: 'all-move',
    targetPosition: { x: 114, y: 105 },
    managerMessage: 'joining the bridge. who has context?',
    agentMessages: ['joining the bridge', 'is this the sev1?', 'muting myself, kids are asleep'],
    sound: 'alarm',
  },
  {
    id: 'pizza',
    name: 'Incident Pizza',
    slackAnnouncement: '🍕 pizza has arrived (expense code: OUTAGE)',
    duration: 5000,
    type: 'all-move',
    targetPosition: { x: 114, y: 105 },
    managerMessage: 'eat fast',
    agentMessages: ['incident pizza hits different', 'second pizza of the night', 'eating over the keyboard, sorry'],
    sound: 'celebration',
  },
  {
    id: 'standup',
    name: 'Status Update',
    slackAnnouncement: '📢 @here what do we know, what are we doing, who is blocked',
    duration: 7000,
    type: 'all-move',
    targetPosition: { x: 411, y: 417 },
    managerMessage: 'go around the room',
    agentMessages: ['error rate 40% and dropping', 'rollback halfway', 'I need a DBA', 'still not DNS. probably DNS.'],
    sound: 'notification',
  },
  {
    id: 'deploy',
    name: 'Rollback Deploy',
    slackAnnouncement: '🚀 ROLLING BACK...',
    duration: 5000,
    type: 'slack-only',
    managerMessage: 'hold',
    agentMessages: ['please', 'watching the graph', 'if this fails we roll back the rollback'],
    sound: 'notification',
  },
  {
    id: 'deploy-success',
    name: 'Rollback Complete',
    slackAnnouncement: '✅ rollback complete — error rate normal',
    duration: 3000,
    type: 'slack-only',
    managerMessage: 'starting the all-clear timer',
    agentMessages: ['breathing again', 'graph is flat', 'who wants the postmortem doc'],
    sound: 'celebration',
  },
  {
    id: 'deploy-fail',
    name: 'Rollback Failed',
    slackAnnouncement: '💥 rollback failed — rolling back the rollback',
    duration: 4000,
    type: 'slack-only',
    managerMessage: 'ok. ok. ok.',
    agentMessages: ['of course', 'migration was not reversible', 'checking the backup'],
    sound: 'error',
  },
  {
    id: 'power-flicker',
    name: 'Rack Power Blip',
    slackAnnouncement: '⚡ UPS kicked in. again.',
    duration: 3000,
    type: 'visual-only',
    agentMessages: ['was that us?', 'the DC is also having a night'],
    sound: 'powerDown',
  },
  {
    id: 'birthday',
    name: 'Shift Change',
    slackAnnouncement: '🕑 EU on-call is awake — handover in the break room',
    duration: 4000,
    type: 'all-move',
    targetPosition: { x: 287, y: 129 },
    managerMessage: 'brief them, then sleep',
    agentMessages: ['handover doc is 3 lines', 'good luck', 'it is Tuesday there'],
    sound: 'notification',
  },
  {
    id: 'who-broke-build',
    name: 'Bisect',
    slackAnnouncement: '🔴 bisecting main — 12 commits between good and bad',
    duration: 5000,
    type: 'slack-only',
    managerMessage: 'blameless. find the commit, not the person.',
    agentMessages: ['4f2a1c is bad', 'a1b2c3 is good', 'it was the config change', 'I blame DNS'],
    sound: 'error',
  },
  {
    id: 'friday',
    name: 'Friday Deploy',
    slackAnnouncement: '📅 reminder: this started as a Friday deploy',
    duration: 3000,
    type: 'slack-only',
    managerMessage: 'never again',
    agentMessages: ['never again', 'we said that last time', 'read-only Fridays from now on'],
    sound: 'notification',
  },
  {
    id: 'printer-jam',
    name: 'Printing The Error Log',
    slackAnnouncement: '🖨️ someone piped kubectl logs to lp',
    duration: 4000,
    type: 'single-agent',
    targetPosition: { x: 424, y: 132 },
    agentMessages: ['it is 400 pages', 'PC LOAD STACKTRACE', 'unplug it'],
    sound: 'error',
  },
  {
    id: 'slack-down',
    name: 'Status Page Is Down',
    slackAnnouncement: '💀 the status page is down. the status page.',
    duration: 3000,
    type: 'slack-only',
    agentMessages: ['of course it is', 'tweet it', 'carrier pigeon time'],
    sound: 'notification',
  },
]

import { getTheme } from './theme'
import { getVariant } from './incident'

export function pickEvent(): RandomOfficeEvent {
  const isOffice = getTheme() === 'office'

  // Incident mode: the deploy chain runs hotter (0.35 vs 0.15) and every
  // event reads as part of the outage. Same ids, so movement targets resolve.
  if (getVariant() === 'incident') {
    if (Math.random() < 0.35) {
      return Math.random() < 0.7
        ? INCIDENT_EVENTS.find(e => e.id === 'deploy-success')!
        : INCIDENT_EVENTS.find(e => e.id === 'deploy-fail')!
    }
    const pool = INCIDENT_EVENTS.filter(e => e.id !== 'deploy-success' && e.id !== 'deploy-fail')
    return pool[Math.floor(Math.random() * pool.length)]
  }

  // Deploy events chain together (kept for both themes)
  if (Math.random() < 0.15) {
    return Math.random() < 0.7
      ? RANDOM_EVENTS.find(e => e.id === 'deploy-success')!
      : RANDOM_EVENTS.find(e => e.id === 'deploy-fail')!
  }

  if (isOffice) {
    // 70% Office-themed, 30% default — keeps things varied
    const useOffice = Math.random() < 0.7
    const pool = useOffice
      ? OFFICE_EVENTS
      : RANDOM_EVENTS.filter(e => e.id !== 'deploy-success' && e.id !== 'deploy-fail')
    return pool[Math.floor(Math.random() * pool.length)]
  }

  const pool = RANDOM_EVENTS.filter(e => e.id !== 'deploy-success' && e.id !== 'deploy-fail')
  return pool[Math.floor(Math.random() * pool.length)]
}
