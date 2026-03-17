/**
 * chat-db.js - SQLite-backed chat history for Agent Office
 *
 * DB location: ~/.agent-office/chat.db
 * Uses WAL mode for concurrent read performance.
 */

import Database from 'better-sqlite3'
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

// ---------------------------------------------------------------------------
// Initialise DB
// ---------------------------------------------------------------------------

const RUNTIME_DIR = join(homedir(), '.agent-office')
try { mkdirSync(RUNTIME_DIR, { recursive: true }) } catch {}

const DB_PATH = join(RUNTIME_DIR, 'chat.db')

const db = new Database(DB_PATH)

// WAL mode for better concurrent read/write performance
db.pragma('journal_mode = WAL')

db.exec(
  'CREATE TABLE IF NOT EXISTS messages (' +
  '  id         INTEGER PRIMARY KEY AUTOINCREMENT,' +
  '  sender     TEXT    NOT NULL,' +
  '  role       TEXT    NOT NULL DEFAULT \'default\',' +
  '  text       TEXT    NOT NULL,' +
  '  timestamp  INTEGER NOT NULL,' +
  '  is_system  INTEGER NOT NULL DEFAULT 0,' +
  '  reactions  TEXT    NOT NULL DEFAULT \'[]\',' +
  '  thread_id  INTEGER,' +
  '  seen       INTEGER NOT NULL DEFAULT 0' +
  ')'
)

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const stmtInsert = db.prepare(
  'INSERT INTO messages (sender, role, text, timestamp, is_system, thread_id) ' +
  'VALUES (@sender, @role, @text, @timestamp, @isSystem, @threadId)'
)

const stmtGetAll = db.prepare(
  'SELECT * FROM (SELECT * FROM messages ORDER BY timestamp DESC, id DESC LIMIT @limit) ' +
  'ORDER BY timestamp ASC, id ASC'
)

const stmtGetSince = db.prepare(
  'SELECT * FROM messages ' +
  'WHERE timestamp > @since ' +
  'ORDER BY timestamp ASC, id ASC ' +
  'LIMIT @limit'
)

const stmtMarkSeen = db.prepare(
  'UPDATE messages SET seen = 1 WHERE id = @id'
)

const stmtGetReactions = db.prepare(
  'SELECT reactions FROM messages WHERE id = @id'
)

const stmtSetReactions = db.prepare(
  'UPDATE messages SET reactions = @reactions WHERE id = @id'
)

const stmtGetThread = db.prepare(
  'SELECT * FROM messages ' +
  'WHERE thread_id = @threadId ' +
  'ORDER BY timestamp ASC, id ASC'
)

const stmtGetById = db.prepare(
  'SELECT * FROM messages WHERE id = @id'
)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new message and return it with its generated id.
 * @param {{ sender: string, role?: string, text: string, isSystem?: boolean, threadId?: number }} opts
 */
export function addMessage({ sender, role = 'default', text, isSystem = false, threadId = null }) {
  const timestamp = Date.now()
  const info = stmtInsert.run({
    sender,
    role,
    text,
    timestamp,
    isSystem: isSystem ? 1 : 0,
    threadId: threadId ?? null,
  })
  return stmtGetById.get({ id: info.lastInsertRowid })
}

/**
 * Retrieve recent messages.
 * @param {{ since?: number, limit?: number }} opts
 */
export function getMessages({ since = 0, limit = 50 } = {}) {
  if (since) {
    return stmtGetSince.all({ since, limit })
  }
  return stmtGetAll.all({ limit })
}

/**
 * Mark a message as seen by the Claude watcher.
 * @param {number} messageId
 */
export function markSeen(messageId) {
  stmtMarkSeen.run({ id: messageId })
}

/**
 * Toggle an emoji reaction on a message.
 * Adds the emoji if not present, removes it if already there.
 * @param {number} messageId
 * @param {string} emoji
 * @returns {string[]} Updated reactions array
 */
export function addReaction(messageId, emoji) {
  const row = stmtGetReactions.get({ id: messageId })
  if (!row) return []

  let reactions
  try {
    reactions = JSON.parse(row.reactions)
    if (!Array.isArray(reactions)) reactions = []
  } catch {
    reactions = []
  }

  const idx = reactions.indexOf(emoji)
  if (idx === -1) {
    reactions.push(emoji)
  } else {
    reactions.splice(idx, 1)
  }

  stmtSetReactions.run({ id: messageId, reactions: JSON.stringify(reactions) })
  return reactions
}

/**
 * Retrieve all messages belonging to a thread.
 * @param {number} threadId
 */
export function getThread(threadId) {
  return stmtGetThread.all({ threadId })
}

export default db
