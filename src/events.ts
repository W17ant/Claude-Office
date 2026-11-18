// Random office events that trigger periodically. Silent on purpose: they
// are office colour, not news (src/sounds.ts keeps sound for real events)
// Every line people read lives in locales/en.json under chatter.events.*.

import { t, list } from './i18n'

export interface RandomOfficeEvent {
  id: string
  name: string
  slackAnnouncement: string
  duration: number // ms
  type: 'all-move' | 'single-agent' | 'visual-only' | 'slack-only'
  targetPosition?: { x: number; y: number }
  agentMessages?: string[]
  managerMessage?: string
}

// Why getters: the text is read when an event fires, not at import, so a
// language change reaches the next event; ids, types and targets stay plain
// values because App.tsx and the incident state machine match on them.
export const RANDOM_EVENTS: RandomOfficeEvent[] = [
  {
    id: 'fire-drill',
    get name() { return t('chatter.events.fireDrill.name') },
    get slackAnnouncement() { return t('chatter.events.fireDrill.announcement') },
    duration: 6000,
    type: 'all-move',
    targetPosition: { x: 114, y: 105 },
    get managerMessage() { return t('chatter.events.fireDrill.managerLine') },
    get agentMessages() { return list('chatter.events.fireDrill.agentLines') },
  },
  {
    id: 'pizza',
    get name() { return t('chatter.events.pizza.name') },
    get slackAnnouncement() { return t('chatter.events.pizza.announcement') },
    duration: 5000,
    type: 'all-move',
    targetPosition: { x: 114, y: 105 },
    get managerMessage() { return t('chatter.events.pizza.managerLine') },
    get agentMessages() { return list('chatter.events.pizza.agentLines') },
  },
  {
    id: 'standup',
    get name() { return t('chatter.events.standup.name') },
    get slackAnnouncement() { return t('chatter.events.standup.announcement') },
    duration: 7000,
    type: 'all-move',
    targetPosition: { x: 411, y: 417 },
    get managerMessage() { return t('chatter.events.standup.managerLine') },
    get agentMessages() { return list('chatter.events.standup.agentLines') },
  },
  {
    id: 'deploy',
    get name() { return t('chatter.events.deploy.name') },
    get slackAnnouncement() { return t('chatter.events.deploy.announcement') },
    duration: 5000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.deploy.managerLine') },
    get agentMessages() { return list('chatter.events.deploy.agentLines') },
  },
  {
    id: 'deploy-success',
    get name() { return t('chatter.events.deploySuccess.name') },
    get slackAnnouncement() { return t('chatter.events.deploySuccess.announcement') },
    duration: 3000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.deploySuccess.managerLine') },
    get agentMessages() { return list('chatter.events.deploySuccess.agentLines') },
  },
  {
    id: 'deploy-fail',
    get name() { return t('chatter.events.deployFail.name') },
    get slackAnnouncement() { return t('chatter.events.deployFail.announcement') },
    duration: 4000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.deployFail.managerLine') },
    get agentMessages() { return list('chatter.events.deployFail.agentLines') },
  },
  {
    id: 'power-flicker',
    get name() { return t('chatter.events.powerFlicker.name') },
    get slackAnnouncement() { return t('chatter.events.powerFlicker.announcement') },
    duration: 3000,
    type: 'visual-only',
    get agentMessages() { return list('chatter.events.powerFlicker.agentLines') },
  },
  {
    id: 'birthday',
    get name() { return t('chatter.events.birthday.name') },
    get slackAnnouncement() { return t('chatter.events.birthday.announcement') },
    duration: 4000,
    type: 'all-move',
    targetPosition: { x: 287, y: 129 },
    get managerMessage() { return t('chatter.events.birthday.managerLine') },
    get agentMessages() { return list('chatter.events.birthday.agentLines') },
  },
  {
    id: 'who-broke-build',
    get name() { return t('chatter.events.whoBrokeBuild.name') },
    get slackAnnouncement() { return t('chatter.events.whoBrokeBuild.announcement') },
    duration: 5000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.whoBrokeBuild.managerLine') },
    get agentMessages() { return list('chatter.events.whoBrokeBuild.agentLines') },
  },
  {
    id: 'friday',
    get name() { return t('chatter.events.friday.name') },
    get slackAnnouncement() { return t('chatter.events.friday.announcement') },
    duration: 3000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.friday.managerLine') },
    get agentMessages() { return list('chatter.events.friday.agentLines') },
  },
  {
    id: 'printer-jam',
    get name() { return t('chatter.events.printerJam.name') },
    get slackAnnouncement() { return t('chatter.events.printerJam.announcement') },
    duration: 4000,
    type: 'single-agent',
    targetPosition: { x: 424, y: 132 },
    get agentMessages() { return list('chatter.events.printerJam.agentLines') },
  },
  {
    id: 'slack-down',
    get name() { return t('chatter.events.slackDown.name') },
    get slackAnnouncement() { return t('chatter.events.slackDown.announcement') },
    duration: 3000,
    type: 'slack-only',
    get agentMessages() { return list('chatter.events.slackDown.agentLines') },
  },
]

/** One drama exchange: lines alternate between the two people, starting with the first. */
function conversation(lines: string[]): { sender: number; text: string }[] {
  // Why: every exchange alternates 0,1,0,1, so the speaker follows from the line's
  // position and a translation can keep, add or drop lines without a sender list
  return lines.map((text, i) => ({ sender: i % 2, text }))
}

// Office drama conversations
export const DRAMA_CONVERSATIONS = [
  {
    trigger: 'coffee-meet',
    get messages() { return conversation(list('chatter.events.drama.coffeeMeet.lines')) },
  },
  {
    trigger: 'who-pushed',
    get messages() { return conversation(list('chatter.events.drama.whoPushed.lines')) },
  },
  {
    trigger: 'tabs-vs-spaces',
    get messages() { return conversation(list('chatter.events.drama.tabsVsSpaces.lines')) },
  },
  {
    trigger: 'meeting',
    get messages() { return conversation(list('chatter.events.drama.meeting.lines')) },
  },
  {
    trigger: 'framework',
    get messages() { return conversation(list('chatter.events.drama.framework.lines')) },
  },
  {
    trigger: 'legacy',
    get messages() { return conversation(list('chatter.events.drama.legacy.lines')) },
  },
  {
    trigger: 'ai',
    get messages() { return conversation(list('chatter.events.drama.ai.lines')) },
  },
  {
    trigger: 'standup-excuse',
    get messages() { return conversation(list('chatter.events.drama.standupExcuse.lines')) },
  },
]

// Slack reactions that randomly appear on messages
export const SLACK_REACTIONS = ['👍', '🔥', '💀', '😂', '🚀', '❤️', '👀', '💯', '🎉', '😅', '🤔', '⚡']

// Dunder Mifflin themed events — used when Office theme is active
export const OFFICE_EVENTS: RandomOfficeEvent[] = [
  {
    id: 'fire-alarm-stress-relief',
    get name() { return t('chatter.events.fireAlarmStressRelief.name') },
    get slackAnnouncement() { return t('chatter.events.fireAlarmStressRelief.announcement') },
    duration: 6000,
    type: 'all-move',
    targetPosition: { x: 114, y: 105 },
    get managerMessage() { return t('chatter.events.fireAlarmStressRelief.managerLine') },
    get agentMessages() { return list('chatter.events.fireAlarmStressRelief.agentLines') },
  },
  {
    id: 'cpr-training',
    get name() { return t('chatter.events.cprTraining.name') },
    get slackAnnouncement() { return t('chatter.events.cprTraining.announcement') },
    duration: 5000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.cprTraining.managerLine') },
    get agentMessages() { return list('chatter.events.cprTraining.agentLines') },
  },
  {
    id: 'golden-ticket',
    get name() { return t('chatter.events.goldenTicket.name') },
    get slackAnnouncement() { return t('chatter.events.goldenTicket.announcement') },
    duration: 4000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.goldenTicket.managerLine') },
    get agentMessages() { return list('chatter.events.goldenTicket.agentLines') },
  },
  {
    id: 'jim-prank',
    get name() { return t('chatter.events.jimPrank.name') },
    get slackAnnouncement() { return t('chatter.events.jimPrank.announcement') },
    duration: 3500,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.jimPrank.managerLine') },
    get agentMessages() { return list('chatter.events.jimPrank.agentLines') },
  },
  {
    id: 'parkour',
    get name() { return t('chatter.events.parkour.name') },
    get slackAnnouncement() { return t('chatter.events.parkour.announcement') },
    duration: 4000,
    type: 'visual-only',
    get managerMessage() { return t('chatter.events.parkour.managerLine') },
    get agentMessages() { return list('chatter.events.parkour.agentLines') },
  },
  {
    id: 'schrute-bucks',
    get name() { return t('chatter.events.schruteBucks.name') },
    get slackAnnouncement() { return t('chatter.events.schruteBucks.announcement') },
    duration: 3000,
    type: 'slack-only',
    get agentMessages() { return list('chatter.events.schruteBucks.agentLines') },
  },
  {
    id: 'kevins-chili',
    get name() { return t('chatter.events.kevinsChili.name') },
    get slackAnnouncement() { return t('chatter.events.kevinsChili.announcement') },
    duration: 4000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.kevinsChili.managerLine') },
    get agentMessages() { return list('chatter.events.kevinsChili.agentLines') },
  },
  {
    id: 'printer-jam-dm',
    get name() { return t('chatter.events.printerJamDm.name') },
    get slackAnnouncement() { return t('chatter.events.printerJamDm.announcement') },
    duration: 4000,
    type: 'single-agent',
    targetPosition: { x: 424, y: 132 },
    get agentMessages() { return list('chatter.events.printerJamDm.agentLines') },
  },
  {
    id: 'dundies',
    get name() { return t('chatter.events.dundies.name') },
    get slackAnnouncement() { return t('chatter.events.dundies.announcement') },
    duration: 4000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.dundies.managerLine') },
    get agentMessages() { return list('chatter.events.dundies.agentLines') },
  },
  {
    id: 'pretzel-day',
    get name() { return t('chatter.events.pretzelDay.name') },
    get slackAnnouncement() { return t('chatter.events.pretzelDay.announcement') },
    duration: 5000,
    type: 'all-move',
    targetPosition: { x: 287, y: 129 },
    get managerMessage() { return t('chatter.events.pretzelDay.managerLine') },
    get agentMessages() { return list('chatter.events.pretzelDay.agentLines') },
  },
  {
    id: 'bears-beets',
    get name() { return t('chatter.events.bearsBeets.name') },
    get slackAnnouncement() { return t('chatter.events.bearsBeets.announcement') },
    duration: 3000,
    type: 'slack-only',
    get agentMessages() { return list('chatter.events.bearsBeets.agentLines') },
  },
]

// Incident-mode events — SAME ids as RANDOM_EVENTS so EVENT_TARGETS in App.tsx
// resolves without new entries; only the copy changes. deploy-fail /
// who-broke-build start a mini-incident and deploy-success ends one (incident.ts).
export const INCIDENT_EVENTS: RandomOfficeEvent[] = [
  {
    id: 'fire-drill',
    get name() { return t('chatter.events.incident.fireDrill.name') },
    get slackAnnouncement() { return t('chatter.events.incident.fireDrill.announcement') },
    duration: 6000,
    type: 'all-move',
    targetPosition: { x: 114, y: 105 },
    get managerMessage() { return t('chatter.events.incident.fireDrill.managerLine') },
    get agentMessages() { return list('chatter.events.incident.fireDrill.agentLines') },
  },
  {
    id: 'pizza',
    get name() { return t('chatter.events.incident.pizza.name') },
    get slackAnnouncement() { return t('chatter.events.incident.pizza.announcement') },
    duration: 5000,
    type: 'all-move',
    targetPosition: { x: 114, y: 105 },
    get managerMessage() { return t('chatter.events.incident.pizza.managerLine') },
    get agentMessages() { return list('chatter.events.incident.pizza.agentLines') },
  },
  {
    id: 'standup',
    get name() { return t('chatter.events.incident.standup.name') },
    get slackAnnouncement() { return t('chatter.events.incident.standup.announcement') },
    duration: 7000,
    type: 'all-move',
    targetPosition: { x: 411, y: 417 },
    get managerMessage() { return t('chatter.events.incident.standup.managerLine') },
    get agentMessages() { return list('chatter.events.incident.standup.agentLines') },
  },
  {
    id: 'deploy',
    get name() { return t('chatter.events.incident.deploy.name') },
    get slackAnnouncement() { return t('chatter.events.incident.deploy.announcement') },
    duration: 5000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.incident.deploy.managerLine') },
    get agentMessages() { return list('chatter.events.incident.deploy.agentLines') },
  },
  {
    id: 'deploy-success',
    get name() { return t('chatter.events.incident.deploySuccess.name') },
    get slackAnnouncement() { return t('chatter.events.incident.deploySuccess.announcement') },
    duration: 3000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.incident.deploySuccess.managerLine') },
    get agentMessages() { return list('chatter.events.incident.deploySuccess.agentLines') },
  },
  {
    id: 'deploy-fail',
    get name() { return t('chatter.events.incident.deployFail.name') },
    get slackAnnouncement() { return t('chatter.events.incident.deployFail.announcement') },
    duration: 4000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.incident.deployFail.managerLine') },
    get agentMessages() { return list('chatter.events.incident.deployFail.agentLines') },
  },
  {
    id: 'power-flicker',
    get name() { return t('chatter.events.incident.powerFlicker.name') },
    get slackAnnouncement() { return t('chatter.events.incident.powerFlicker.announcement') },
    duration: 3000,
    type: 'visual-only',
    get agentMessages() { return list('chatter.events.incident.powerFlicker.agentLines') },
  },
  {
    id: 'birthday',
    get name() { return t('chatter.events.incident.birthday.name') },
    get slackAnnouncement() { return t('chatter.events.incident.birthday.announcement') },
    duration: 4000,
    type: 'all-move',
    targetPosition: { x: 287, y: 129 },
    get managerMessage() { return t('chatter.events.incident.birthday.managerLine') },
    get agentMessages() { return list('chatter.events.incident.birthday.agentLines') },
  },
  {
    id: 'who-broke-build',
    get name() { return t('chatter.events.incident.whoBrokeBuild.name') },
    get slackAnnouncement() { return t('chatter.events.incident.whoBrokeBuild.announcement') },
    duration: 5000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.incident.whoBrokeBuild.managerLine') },
    get agentMessages() { return list('chatter.events.incident.whoBrokeBuild.agentLines') },
  },
  {
    id: 'friday',
    get name() { return t('chatter.events.incident.friday.name') },
    get slackAnnouncement() { return t('chatter.events.incident.friday.announcement') },
    duration: 3000,
    type: 'slack-only',
    get managerMessage() { return t('chatter.events.incident.friday.managerLine') },
    get agentMessages() { return list('chatter.events.incident.friday.agentLines') },
  },
  {
    id: 'printer-jam',
    get name() { return t('chatter.events.incident.printerJam.name') },
    get slackAnnouncement() { return t('chatter.events.incident.printerJam.announcement') },
    duration: 4000,
    type: 'single-agent',
    targetPosition: { x: 424, y: 132 },
    get agentMessages() { return list('chatter.events.incident.printerJam.agentLines') },
  },
  {
    id: 'slack-down',
    get name() { return t('chatter.events.incident.slackDown.name') },
    get slackAnnouncement() { return t('chatter.events.incident.slackDown.announcement') },
    duration: 3000,
    type: 'slack-only',
    get agentMessages() { return list('chatter.events.incident.slackDown.agentLines') },
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
