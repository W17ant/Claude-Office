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

export function pickEvent(): RandomOfficeEvent {
  // Deploy events chain together
  if (Math.random() < 0.15) {
    // 70% success, 30% fail
    return Math.random() < 0.7
      ? RANDOM_EVENTS.find(e => e.id === 'deploy-success')!
      : RANDOM_EVENTS.find(e => e.id === 'deploy-fail')!
  }
  const pool = RANDOM_EVENTS.filter(e => e.id !== 'deploy-success' && e.id !== 'deploy-fail')
  return pool[Math.floor(Math.random() * pool.length)]
}
